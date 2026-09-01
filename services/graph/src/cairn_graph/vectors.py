"""Semantic search over the structure graph — the second of the plan's
three-index design (parse graph + vector index + relationship/dependency
index — see `dependencies.py` for the third). Answers "what code does
something like this" queries that name-substring search (`cli.py`'s
`query` / MCP's `search`) structurally can't — a symbol named
`computeTotal` and one named `sumLineItems` are unrelated by name but
adjacent by meaning.

Embeddings run locally via fastembed (ONNX runtime, no torch — a much
smaller install than sentence-transformers for the same job). Model
weights are fetched once from Hugging Face on first use and cached under
~/.cache/fastembed; every embedding call after that runs fully offline.
Consistent with the on-prem/no-data-leakage story: customer *code* never
leaves the machine — only a one-time, content-free model-weight download
happens, the same category of network access `pip install` itself needs.

**A faster model was tried, benchmarked, and rejected — worth recording
why, not just that it didn't ship.** `sentence-transformers/
all-MiniLM-L6-v2` measured a real 32x speedup (336.1ms → 10.5ms per
symbol) with zero quality loss on a narrow 4-query check reusing this
session's earlier dogfood scenarios. That check was too narrow: rerun at
real scale (850 symbols, the actual cairn repo, all four queries against
the *full* corpus instead of 4 hand-picked candidates), one of the four
broke outright — "resolve a user command into an action" no longer
returned `resolveVerb` anywhere in the top 15, where the original model
correctly ranks it #1 at 0.716 on the identical corpus, confirmed
apples-to-apples with the sync state reset between runs. Speed that
breaks search quality isn't an optimization; reverted to
`BAAI/bge-small-en-v1.5`.

**What did ship**: multiprocess `parallel=` embedding, which changes
*nothing* about quality (same model, same vectors, computed
concurrently instead of serially) — measured a real 1.37x speedup at
realistic snippet length (336.1ms → 245.1ms per symbol), worth taking
since it carries none of the model-swap's risk. `parallel` is threaded
through `embed_texts`/`build_vector_index` rather than hardcoded, since
the right worker count is a property of the machine running this, not a
constant this module should assume.

Storage is Qdrant in embedded/local mode (`QdrantClient(path=...)`, no
server process) — an on-disk vector index next to the SQLite graph, same
"just files, no infra to run" shape as the rest of this service. A real
Qdrant server is a drop-in swap (`QdrantClient(url=...)`) for deployments
that need it at larger scale; not built here since embedded mode covers
this product's realistic single-customer-codebase scale.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Sequence

from cairn_graph.store import get_vector_sync_state, open_store, remove_vector_sync_state, set_vector_sync_state

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
_MAX_SNIPPET_LINES = 40

EmbedFn = Callable[[Sequence[str]], list[list[float]]]

_model_cache: dict[str, object] = {}


def _get_embedder(model_name: str):
    if model_name not in _model_cache:
        from fastembed import TextEmbedding

        _model_cache[model_name] = TextEmbedding(model_name=model_name)
    return _model_cache[model_name]


def embed_texts(
    texts: Sequence[str], model_name: str = DEFAULT_MODEL, embed_fn: EmbedFn | None = None, parallel: int | None = None
) -> list[list[float]]:
    """The one place model choice is decided — swapped out in tests via
    `embed_fn` so the suite never needs a network call or a loaded model.

    `parallel` maps directly to fastembed's own multiprocess embedding —
    measured live at realistic snippet length (~2.6k chars): a real 1.37x
    speedup (336.1ms -> 245.1ms per text) for this specific model, with
    zero effect on the output (same model, same vectors, just computed
    concurrently). Not defaulted on unconditionally here: for a tiny
    batch the worker-process spawn cost can exceed what it saves, so
    `build_vector_index` below only requests it once a run is large
    enough to be worth the overhead."""
    if embed_fn is not None:
        return embed_fn(texts)
    if not texts:
        return []
    model = _get_embedder(model_name)
    return [vec.tolist() for vec in model.embed(list(texts), parallel=parallel)]


def _read_snippet(file_path: str, start_line: int, end_line: int) -> str:
    try:
        lines = Path(file_path).read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return ""
    # start_line/end_line are 1-indexed and inclusive, as stored by extract.py.
    capped_end = min(end_line, start_line + _MAX_SNIPPET_LINES - 1)
    return "\n".join(lines[start_line - 1 : capped_end])


def _symbol_text(kind: str, name: str, parent: str | None, snippet: str) -> str:
    header = f"{kind} {name}" + (f" (in {parent})" if parent else "")
    return f"{header}\n{snippet}" if snippet else header


@dataclass
class SymbolForEmbedding:
    id: int
    kind: str
    name: str
    parent: str | None
    file_path: str
    start_line: int
    end_line: int


def _load_symbols(conn: sqlite3.Connection) -> list[SymbolForEmbedding]:
    rows = conn.execute(
        "SELECT s.id, s.kind, s.name, s.parent, f.path, s.start_line, s.end_line "
        "FROM symbols s JOIN files f ON f.id = s.file_id"
    ).fetchall()
    return [SymbolForEmbedding(*row) for row in rows]


def _delete_points_for_file(client, file_path: str) -> None:
    """Removes every existing point for one file before re-embedding it —
    necessary, not just tidy: a changed file gets fresh symbol ids on
    reindex (upsert_file deletes and reinserts its rows), so its old
    vector points would otherwise become permanently orphaned garbage in
    the collection, never overwritten by an upsert under a new id."""
    from qdrant_client.models import FieldCondition, Filter, MatchValue

    if not client.collection_exists("symbols"):
        return
    client.delete(collection_name="symbols", points_selector=Filter(must=[FieldCondition(key="file", match=MatchValue(value=file_path))]))


@dataclass
class VectorIndexSummary:
    symbols_embedded: int
    batches: int
    files_changed: int = 0
    files_skipped_unchanged: int = 0
    files_removed: int = 0


_PARALLEL_WORTH_IT_ABOVE = 50  # symbols — below this, worker-spawn overhead measured to exceed the savings


def build_vector_index(
    db_path: str,
    vector_dir: str,
    model_name: str = DEFAULT_MODEL,
    embed_fn: EmbedFn | None = None,
    batch_size: int = 64,
    parallel: int | None = None,
) -> VectorIndexSummary:
    """Incremental: only (re-)embeds files whose content_hash has changed
    since the last `build_vector_index` call, the same content-hash lever
    `build.py` uses for parsing — the thing that keeps a lakhs-of-files
    repo's *second* vectorize fast, not just its second parse. Reads each
    symbol's own source lines off disk (not just its name) so the
    embedding captures what the code actually does, not just what it's
    called.

    `parallel` defaults to None (fastembed's own serial path) rather than
    always-on: most calls here are incremental (a handful of changed
    files), where multiprocess spawn overhead measured live to exceed
    what it saves. Left unset, a large enough run (more symbols than
    `_PARALLEL_WORTH_IT_ABOVE`) auto-enables it; pass an explicit value
    to override either way."""
    conn = open_store(db_path)  # ensures vector_sync exists even if this db was never opened via open_store before

    current_files = dict(conn.execute("SELECT path, content_hash FROM files").fetchall())
    synced = get_vector_sync_state(conn)

    changed_paths = {p for p, h in current_files.items() if synced.get(p) != h}
    removed_paths = set(synced) - set(current_files)
    skipped_paths = set(current_files) - changed_paths

    if not changed_paths and not removed_paths:
        return VectorIndexSummary(
            symbols_embedded=0, batches=0, files_changed=0, files_skipped_unchanged=len(skipped_paths), files_removed=0
        )

    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, PointStruct, VectorParams

    # One client for this whole call, never two: embedded Qdrant holds an
    # exclusive file lock on `vector_dir`, so a second QdrantClient(path=...)
    # against the same directory while this one is still open raises
    # RuntimeError — found live the first time this function both deleted
    # stale points *and* needed to create the collection in the same call,
    # via a leftover `_open_collection()` call that opened a second client.
    client = QdrantClient(path=vector_dir)
    for path in removed_paths | changed_paths:
        _delete_points_for_file(client, path)
    for path in removed_paths:
        remove_vector_sync_state(conn, path)
    conn.commit()

    all_symbols = _load_symbols(conn)
    symbols = [s for s in all_symbols if s.file_path in changed_paths]

    if not symbols:
        return VectorIndexSummary(
            symbols_embedded=0, batches=0, files_changed=len(changed_paths), files_skipped_unchanged=len(skipped_paths), files_removed=len(removed_paths)
        )

    texts = [_symbol_text(s.kind, s.name, s.parent, _read_snippet(s.file_path, s.start_line, s.end_line)) for s in symbols]
    effective_parallel = parallel if parallel is not None else (4 if len(symbols) > _PARALLEL_WORTH_IT_ABOVE else None)

    batches = 0
    for start in range(0, len(symbols), batch_size):
        chunk_symbols = symbols[start : start + batch_size]
        chunk_texts = texts[start : start + batch_size]
        vectors = embed_texts(chunk_texts, model_name=model_name, embed_fn=embed_fn, parallel=effective_parallel)
        # Collection creation needs the real embedding dimension, which is
        # only known once something has actually been embedded — get it
        # from this first real batch rather than a separate throwaway
        # embed_texts(texts[:1]) call that used to embed the very first
        # text twice (once alone, once again as part of this loop's first
        # chunk) for no reason.
        if not client.collection_exists("symbols"):
            dim = len(vectors[0]) if vectors else 0
            client.create_collection(collection_name="symbols", vectors_config=VectorParams(size=dim, distance=Distance.COSINE))
        points = [
            PointStruct(
                id=sym.id,
                vector=vec,
                payload={
                    "kind": sym.kind,
                    "name": sym.name,
                    "parent": sym.parent,
                    "file": sym.file_path,
                    "start_line": sym.start_line,
                    "end_line": sym.end_line,
                },
            )
            for sym, vec in zip(chunk_symbols, vectors)
        ]
        client.upsert(collection_name="symbols", points=points)
        batches += 1

    for path in changed_paths:
        set_vector_sync_state(conn, path, current_files[path])
    conn.commit()

    return VectorIndexSummary(
        symbols_embedded=len(symbols),
        batches=batches,
        files_changed=len(changed_paths),
        files_skipped_unchanged=len(skipped_paths),
        files_removed=len(removed_paths),
    )


def search_semantic(
    vector_dir: str,
    query: str,
    model_name: str = DEFAULT_MODEL,
    embed_fn: EmbedFn | None = None,
    limit: int = 10,
) -> list[dict]:
    """Nearest-neighbor search by meaning, not name — the counterpart to
    `search_symbols`'s substring match."""
    from qdrant_client import QdrantClient

    client = QdrantClient(path=vector_dir)
    if not client.collection_exists("symbols"):
        return []
    [query_vec] = embed_texts([query], model_name=model_name, embed_fn=embed_fn)
    result = client.query_points(collection_name="symbols", query=query_vec, limit=limit)
    return [{"score": p.score, **p.payload} for p in result.points]

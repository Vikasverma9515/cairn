"""Semantic search over the structure graph — the second of the plan's
three-index design (parse graph + vector index + eventually a
relationship/dependency index). Answers "what code does something like
this" queries that name-substring search (`cli.py`'s `query` / MCP's
`search`) structurally can't — a symbol named `computeTotal` and one named
`sumLineItems` are unrelated by name but adjacent by meaning.

Embeddings run locally via fastembed (ONNX runtime, no torch — a much
smaller install than sentence-transformers for the same job). Model
weights are fetched once from Hugging Face on first use and cached under
~/.cache/fastembed; every embedding call after that runs fully offline.
Consistent with the on-prem/no-data-leakage story: customer *code* never
leaves the machine — only a one-time, content-free model-weight download
happens, the same category of network access `pip install` itself needs.

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

DEFAULT_MODEL = "BAAI/bge-small-en-v1.5"
_MAX_SNIPPET_LINES = 40

EmbedFn = Callable[[Sequence[str]], list[list[float]]]

_model_cache: dict[str, object] = {}


def _get_embedder(model_name: str):
    if model_name not in _model_cache:
        from fastembed import TextEmbedding

        _model_cache[model_name] = TextEmbedding(model_name=model_name)
    return _model_cache[model_name]


def embed_texts(texts: Sequence[str], model_name: str = DEFAULT_MODEL, embed_fn: EmbedFn | None = None) -> list[list[float]]:
    """The one place model choice is decided — swapped out in tests via
    `embed_fn` so the suite never needs a network call or a loaded model."""
    if embed_fn is not None:
        return embed_fn(texts)
    if not texts:
        return []
    model = _get_embedder(model_name)
    return [vec.tolist() for vec in model.embed(list(texts))]


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


def _open_collection(vector_dir: str, dim: int):
    from qdrant_client import QdrantClient
    from qdrant_client.models import Distance, VectorParams

    client = QdrantClient(path=vector_dir)
    if not client.collection_exists("symbols"):
        client.create_collection(collection_name="symbols", vectors_config=VectorParams(size=dim, distance=Distance.COSINE))
    return client


@dataclass
class VectorIndexSummary:
    symbols_embedded: int
    batches: int


def build_vector_index(
    db_path: str,
    vector_dir: str,
    model_name: str = DEFAULT_MODEL,
    embed_fn: EmbedFn | None = None,
    batch_size: int = 64,
) -> VectorIndexSummary:
    """Full rebuild of the vector index from the current structure graph.
    Reads each symbol's own source lines off disk (not just its name) so
    the embedding captures what the code actually does, not just what
    it's called."""
    from qdrant_client.models import PointStruct

    conn = sqlite3.connect(db_path)
    symbols = _load_symbols(conn)
    if not symbols:
        return VectorIndexSummary(symbols_embedded=0, batches=0)

    texts = [_symbol_text(s.kind, s.name, s.parent, _read_snippet(s.file_path, s.start_line, s.end_line)) for s in symbols]

    first_batch = embed_texts(texts[:1], model_name=model_name, embed_fn=embed_fn)
    dim = len(first_batch[0]) if first_batch else 0
    client = _open_collection(vector_dir, dim)

    batches = 0
    for start in range(0, len(symbols), batch_size):
        chunk_symbols = symbols[start : start + batch_size]
        chunk_texts = texts[start : start + batch_size]
        vectors = embed_texts(chunk_texts, model_name=model_name, embed_fn=embed_fn)
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

    return VectorIndexSummary(symbols_embedded=len(symbols), batches=batches)


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

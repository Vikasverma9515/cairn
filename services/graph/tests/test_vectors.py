from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path

from cairn_graph.build import build_graph
from cairn_graph.vectors import build_vector_index, search_semantic

_DIM = 32


def _fake_embed(texts):
    """Deterministic, network-free stand-in for a real embedding model:
    a hashing-trick bag-of-words vector, L2-normalized. Two texts sharing
    more words land closer together under cosine similarity — the same
    property a real embedding model has, without downloading one."""
    vectors = []
    for text in texts:
        vec = [0.0] * _DIM
        for word in re.findall(r"[a-zA-Z_]+", text.lower()):
            idx = int(hashlib.sha256(word.encode()).hexdigest(), 16) % _DIM
            vec[idx] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        vectors.append([v / norm for v in vec])
    return vectors


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_build_vector_index_embeds_every_symbol(tmp_path: Path):
    write(tmp_path / "a.ts", "export function total() { return 1; }\nfunction helper() { return 2; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    vectors = tmp_path / "vectors"
    summary = build_vector_index(str(db), str(vectors), embed_fn=_fake_embed)

    assert summary.symbols_embedded == 2
    assert summary.batches == 1


def test_search_semantic_ranks_by_shared_vocabulary(tmp_path: Path):
    write(
        tmp_path / "a.ts",
        """
        export function calculateInvoiceTotal(items) { return items.reduce((a, b) => a + b.price, 0); }
        export function sendWelcomeEmail(user) { return mailer.send(user.email, "welcome"); }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    vectors = tmp_path / "vectors"
    build_vector_index(str(db), str(vectors), embed_fn=_fake_embed)

    results = search_semantic(str(vectors), "sum up invoice price total", embed_fn=_fake_embed, limit=2)

    assert results[0]["name"] == "calculateInvoiceTotal"


def test_search_semantic_against_empty_index_returns_empty_list(tmp_path: Path):
    vectors = tmp_path / "vectors"
    results = search_semantic(str(vectors), "anything", embed_fn=_fake_embed)
    assert results == []


def test_build_vector_index_on_empty_graph_embeds_nothing(tmp_path: Path):
    write(tmp_path / "empty.txt", "not source code")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    vectors = tmp_path / "vectors"
    summary = build_vector_index(str(db), str(vectors), embed_fn=_fake_embed)

    assert summary.symbols_embedded == 0
    assert summary.batches == 0


def test_search_semantic_results_include_location(tmp_path: Path):
    write(tmp_path / "a.ts", "export function widgetRenderer() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    vectors = tmp_path / "vectors"
    build_vector_index(str(db), str(vectors), embed_fn=_fake_embed)

    results = search_semantic(str(vectors), "widget renderer", embed_fn=_fake_embed, limit=1)

    assert results[0]["kind"] == "function"
    assert results[0]["file"].endswith("a.ts")
    assert results[0]["start_line"] == 1

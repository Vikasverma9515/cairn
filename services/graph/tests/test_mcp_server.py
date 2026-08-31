from __future__ import annotations

import asyncio
from pathlib import Path

from cairn_graph.actions import PermissionMode
from cairn_graph.build import build_graph
from cairn_graph.mcp_server import (
    apply_edit_gated,
    build_server,
    find_dead_code,
    get_index_stats,
    get_symbol_usages,
    reindex,
    search_symbols,
    semantic_search,
)
from cairn_graph.store import open_store
from cairn_graph.vectors import build_vector_index


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def _built(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./b";\nexport function fromA() { return helper(); }')
    write(tmp_path / "b.ts", "export function helper() { return 1; }\nfunction _unused() { return 2; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))
    return open_store(str(db)), db


def test_search_symbols_finds_by_substring(tmp_path: Path):
    conn, _ = _built(tmp_path)
    results = search_symbols(conn, "help")
    assert any(r["name"] == "helper" and r["kind"] == "function" for r in results)


def test_search_symbols_respects_limit(tmp_path: Path):
    conn, _ = _built(tmp_path)
    results = search_symbols(conn, "", limit=1)
    assert len(results) == 1


def test_get_symbol_usages_finds_the_call_site(tmp_path: Path):
    conn, _ = _built(tmp_path)
    usages = get_symbol_usages(conn, "helper")
    assert usages["name"] == "helper"
    assert any(c["caller"] == "fromA" for c in usages["called_from"])


def test_get_symbol_usages_for_unused_name_is_empty(tmp_path: Path):
    conn, _ = _built(tmp_path)
    usages = get_symbol_usages(conn, "totallyMadeUpNameNotInCode")
    assert usages["called_from"] == []
    assert usages["referenced_from"] == []


def test_find_dead_code_flags_the_genuinely_unused_function(tmp_path: Path):
    conn, _ = _built(tmp_path)
    result = find_dead_code(conn)
    dead_names = {s["name"] for s in result["dead_symbols"]}
    assert "_unused" in dead_names
    assert "helper" not in dead_names  # reachable via the cross-file import + call


def test_find_dead_code_respects_limit_and_reports_truncation(tmp_path: Path):
    write(tmp_path / "many.ts", "\n".join(f"function dead{i}() {{ return {i}; }}" for i in range(10)))
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))
    conn = open_store(str(db))

    result = find_dead_code(conn, limit=3)
    assert len(result["dead_symbols"]) == 3
    assert result["dead_count"] >= 10
    assert result["truncated"] is True


def test_get_index_stats_reports_real_counts(tmp_path: Path):
    conn, _ = _built(tmp_path)
    s = get_index_stats(conn)
    assert s["files"] == 2
    assert s["symbols"] >= 2


def test_reindex_picks_up_a_new_file(tmp_path: Path):
    conn, db = _built(tmp_path)
    before = get_index_stats(conn)

    write(tmp_path / "c.ts", "export function fromC() { return 1; }")
    summary = reindex(str(db), str(tmp_path))
    assert summary["parsed"] >= 1

    conn2 = open_store(str(db))
    after = get_index_stats(conn2)
    assert after["files"] == before["files"] + 1


def _fake_embed(texts):
    # Deterministic, network-free stand-in — same trick as test_vectors.py.
    import hashlib
    import math
    import re

    dim = 32
    vectors = []
    for text in texts:
        vec = [0.0] * dim
        for word in re.findall(r"[a-zA-Z_]+", text.lower()):
            idx = int(hashlib.sha256(word.encode()).hexdigest(), 16) % dim
            vec[idx] += 1.0
        norm = math.sqrt(sum(v * v for v in vec)) or 1.0
        vectors.append([v / norm for v in vec])
    return vectors


def test_semantic_search_returns_empty_before_vectorize_has_run(tmp_path: Path):
    _, db = _built(tmp_path)
    result = semantic_search(str(tmp_path / "vectors"), "anything")
    assert result["results"] == []


def test_semantic_search_finds_a_match_after_vectorize(tmp_path: Path):
    _, db = _built(tmp_path)
    vector_dir = tmp_path / "vectors"
    build_vector_index(str(db), str(vector_dir), embed_fn=_fake_embed)

    result = semantic_search(str(vector_dir), "helper", embed_fn=_fake_embed)

    assert result["query"] == "helper"
    assert any(r["name"] == "helper" for r in result["results"])


def test_build_server_registers_all_expected_tools(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"))
    tools = asyncio.run(server.list_tools())
    tool_names = {t.name for t in tools}
    assert {
        "search",
        "usages",
        "dead_code",
        "stats_tool",
        "reindex_tool",
        "semantic",
        "vectorize_tool",
        "apply_edit_tool",
    } <= tool_names


def test_apply_edit_gated_needs_approval_in_review_mode_and_leaves_file_untouched(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("const greeting = 'hi';")

    result = apply_edit_gated(str(tmp_path), "a.ts", "'hi'", "'hello'", PermissionMode.REVIEW)

    assert result["status"] == "needs_approval"
    assert f.read_text() == "const greeting = 'hi';"


def test_apply_edit_gated_proceeds_in_auto_mode(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("const greeting = 'hi';")

    result = apply_edit_gated(str(tmp_path), "a.ts", "'hi'", "'hello'", PermissionMode.AUTO)

    assert result["status"] == "applied"
    assert f.read_text() == "const greeting = 'hello';"


def test_apply_edit_gated_proceeds_in_review_mode_once_approved(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("const greeting = 'hi';")

    result = apply_edit_gated(str(tmp_path), "a.ts", "'hi'", "'hello'", PermissionMode.REVIEW, approved=True)

    assert result["status"] == "applied"
    assert f.read_text() == "const greeting = 'hello';"

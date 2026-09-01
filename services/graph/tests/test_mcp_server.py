from __future__ import annotations

import asyncio
from pathlib import Path

from cairn_graph.actions import PermissionMode
from cairn_graph.build import build_graph
from cairn_graph.mcp_server import (
    apply_edit_gated,
    audit_log,
    build_server,
    create_file_gated,
    delete_file_gated,
    find_dead_code,
    get_index_stats,
    get_symbol_usages,
    reindex,
    run_command_gated,
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
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))
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
        "create_file_tool",
        "delete_file_tool",
        "run_command_tool",
        "audit_log_tool",
        "remember_tool",
        "recall_tool",
        "record_turn_tool",
        "recent_history_tool",
        "analytics_tool",
        "customer_overview_tool",
        "file_dependencies_tool",
        "file_dependents_tool",
        "dependency_summary_tool",
        "dashboard_tool",
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


def test_run_command_gated_needs_approval_even_in_auto_mode(tmp_path: Path):
    result = run_command_gated(str(tmp_path), ["echo", "hi"], PermissionMode.AUTO)
    assert result["status"] == "needs_approval"


def test_run_command_gated_runs_once_approved(tmp_path: Path):
    (tmp_path / "marker.txt").write_text("present")
    result = run_command_gated(str(tmp_path), ["ls", "marker.txt"], PermissionMode.AUTO, approved=True)
    assert result["status"] == "ran"
    assert "marker.txt" in result["stdout"]


def test_create_file_gated_proceeds_in_auto_mode(tmp_path: Path):
    result = create_file_gated(str(tmp_path), "new.ts", "export const x = 1;", PermissionMode.AUTO)
    assert result["status"] == "applied"
    assert (tmp_path / "new.ts").read_text() == "export const x = 1;"


def test_delete_file_gated_needs_approval_even_in_auto_mode(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("x")
    result = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO)
    assert result["status"] == "needs_approval"
    assert f.exists()  # untouched


def test_delete_file_gated_runs_once_approved(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("x")
    result = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.REVIEW, approved=True)
    assert result["status"] == "applied"
    assert not f.exists()


def _call(server, name: str, arguments: dict):
    # structured_content holds the real typed return value; a list-returning
    # tool gets wrapped as {"result": [...]} by the SDK, a dict-returning
    # tool comes back as that dict directly.
    result = asyncio.run(server.call_tool(name, arguments))
    return result.structured_content


def test_search_tool_works_through_the_real_compiled_server_not_just_the_plain_function(tmp_path: Path):
    # Regression guard: the SDK runs sync tool functions on a worker
    # thread (anyio.to_thread.run_sync), not the thread that opened the
    # sqlite connection. Calling search_symbols(conn, ...) directly never
    # exercises that thread hop; only a real call_tool() does — this is
    # exactly how the cross-thread sqlite3 crash was first found.
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    results = _call(server, "search", {"query": "help", "limit": 20})

    assert any(r["name"] == "helper" for r in results["result"])


def test_memory_tools_round_trip_through_the_real_compiled_server(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    _call(server, "remember_tool", {"customer_id": "acme", "key": "framework", "value": "nextjs"})
    facts = _call(server, "recall_tool", {"customer_id": "acme"})
    assert facts == {"framework": "nextjs"}

    _call(server, "record_turn_tool", {"customer_id": "acme", "role": "user", "content": "hello"})
    history = _call(server, "recent_history_tool", {"customer_id": "acme"})
    assert history["turns"][0]["content"] == "hello"
    assert history["turns"][0]["role"] == "user"


def test_file_dependencies_tool_resolves_a_real_relative_import(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    result = _call(server, "file_dependencies_tool", {"file_path": str(tmp_path / "a.ts")})

    assert result["internal"] == [str(tmp_path / "b.ts")]


def test_file_dependents_tool_is_the_reverse(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    result = _call(server, "file_dependents_tool", {"file_path": str(tmp_path / "b.ts")})

    assert result["dependents"] == [str(tmp_path / "a.ts")]


def test_dependency_summary_tool_reports_no_cycles_for_this_fixture(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    result = _call(server, "dependency_summary_tool", {})

    assert result["cycle_count"] == 0
    assert result["most_depended_on"][0]["file"] == str(tmp_path / "b.ts")


def test_dashboard_tool_without_a_configured_provider_says_so_plainly(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    result = _call(server, "dashboard_tool", {})

    assert "No LLM provider configured" in result["narrative"]
    assert "<title>" in result["html"]
    assert result["narrative"] in result["html"]


def test_analytics_tool_reflects_a_real_gated_action_through_the_compiled_server(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    _call(server, "apply_edit_tool", {"file_path": "a.ts", "old_text": "helper", "new_text": "helper2"})  # blocked -> logged

    result = _call(server, "analytics_tool", {})
    assert result["summary"]["total_actions"] == 1
    assert result["summary"]["by_outcome"] == {"needs_approval": 1}


def test_customer_overview_tool_lists_a_customer_after_a_remembered_fact_and_action(tmp_path: Path):
    _, db = _built(tmp_path)
    server = build_server(str(db), str(tmp_path), str(tmp_path / "vectors"), memory_db=str(tmp_path / "memory.db"))

    _call(server, "record_turn_tool", {"customer_id": "acme", "role": "user", "content": "hi"})

    result = _call(server, "customer_overview_tool", {})
    by_id = {c["customer_id"]: c for c in result["customers"]}
    assert by_id["acme"]["conversation_turn_count"] == 1


def test_gated_actions_are_recorded_in_the_audit_log_when_a_conn_is_given(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    f = tmp_path / "a.ts"
    f.write_text("hi")

    apply_edit_gated(str(tmp_path), "a.ts", "hi", "bye", PermissionMode.REVIEW, conn=conn)  # blocked -> logged
    apply_edit_gated(str(tmp_path), "a.ts", "hi", "bye", PermissionMode.AUTO, conn=conn)  # applied -> logged

    log = audit_log(conn)
    outcomes = [e["outcome"] for e in log["entries"]]
    assert "needs_approval" in outcomes
    assert "applied" in outcomes


def test_approved_true_alone_is_refused_when_a_real_conn_is_present(tmp_path: Path):
    """The finding this test guards: approved=true is a plain argument
    the calling model controls. Without a conn there's no log to check
    against, so it's honored directly (see the test above) — but with a
    real conn, a bare approved=true (no request_id, or a made-up one)
    must NOT skip the gate, or a prompt-injected "just say yes" instruction
    could delete/run/edit for free on the very first call."""
    conn = open_store(str(tmp_path / "g.db"))
    f = tmp_path / "a.ts"
    f.write_text("x")

    result = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, approved=True, conn=conn)

    assert result["status"] == "needs_approval"
    assert f.exists()  # never actually deleted


def test_approved_true_with_a_fabricated_request_id_is_refused(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    f = tmp_path / "a.ts"
    f.write_text("x")

    result = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, approved=True, conn=conn, request_id=99999)

    assert result["status"] == "needs_approval"
    assert f.exists()


def test_approved_true_with_the_real_request_id_from_the_prior_response_actually_proceeds(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    f = tmp_path / "a.ts"
    f.write_text("x")

    first = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, conn=conn)
    assert first["status"] == "needs_approval"
    request_id = first["request_id"]

    second = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, approved=True, conn=conn, request_id=request_id)

    assert second["status"] == "ran" or second["status"] == "applied"
    assert not f.exists()


def test_a_request_id_cannot_be_replayed_for_a_second_deletion(tmp_path: Path):
    """One request_id resolves once — reusing it after the file is already
    gone (or after any other retry) must not silently re-run the action."""
    conn = open_store(str(tmp_path / "g.db"))
    f = tmp_path / "a.ts"
    f.write_text("x")

    first = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, conn=conn)
    request_id = first["request_id"]
    delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, approved=True, conn=conn, request_id=request_id)

    replay = delete_file_gated(str(tmp_path), "a.ts", PermissionMode.AUTO, approved=True, conn=conn, request_id=request_id)

    assert replay["status"] == "needs_approval"


def test_a_request_id_from_a_different_action_cannot_approve_this_one(tmp_path: Path):
    """A pending request_id for editing file a.ts must not also approve
    deleting file b.ts — the tool_name/description match in `_gate` is
    what this test exercises."""
    conn = open_store(str(tmp_path / "g.db"))
    a = tmp_path / "a.ts"
    a.write_text("x")
    b = tmp_path / "b.ts"
    b.write_text("y")

    edit_request = apply_edit_gated(str(tmp_path), "a.ts", "x", "z", PermissionMode.REVIEW, conn=conn)
    request_id = edit_request["request_id"]

    delete_attempt = delete_file_gated(str(tmp_path), "b.ts", PermissionMode.AUTO, approved=True, conn=conn, request_id=request_id)

    assert delete_attempt["status"] == "needs_approval"
    assert b.exists()

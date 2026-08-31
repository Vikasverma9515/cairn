from __future__ import annotations

from pathlib import Path

from cairn_graph.store import list_action_log, log_action, open_store


def test_log_action_records_an_entry(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "replace text in a.ts", "review", "needs_approval")

    entries = list_action_log(conn)

    assert len(entries) == 1
    assert entries[0].tool_name == "apply_edit"
    assert entries[0].outcome == "needs_approval"


def test_list_action_log_orders_most_recent_first(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "first", "review", "applied")
    log_action(conn, "run_command", "second", "critical", "needs_approval")

    entries = list_action_log(conn)

    assert [e.description for e in entries] == ["second", "first"]


def test_list_action_log_respects_limit(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    for i in range(5):
        log_action(conn, "apply_edit", f"edit {i}", "review", "applied")

    entries = list_action_log(conn, limit=2)

    assert len(entries) == 2


def test_list_action_log_filters_by_customer_id(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "for acme", "review", "applied", customer_id="acme")
    log_action(conn, "apply_edit", "for globex", "review", "applied", customer_id="globex")

    entries = list_action_log(conn, customer_id="acme")

    assert len(entries) == 1
    assert entries[0].description == "for acme"

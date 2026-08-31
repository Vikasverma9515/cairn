from __future__ import annotations

import time
from pathlib import Path

from cairn_graph.analytics import action_summary, approval_rate, customer_overview, daily_activity, top_tools
from cairn_graph.memory import open_memory_store, record_turn
from cairn_graph.store import log_action, open_store


def test_action_summary_counts_by_outcome_and_risk(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "a", "review", "applied", customer_id="acme")
    log_action(conn, "apply_edit", "b", "review", "needs_approval", customer_id="acme")
    log_action(conn, "run_command", "c", "critical", "needs_approval", customer_id="acme")

    summary = action_summary(conn)

    assert summary["total_actions"] == 3
    assert summary["by_outcome"] == {"applied": 1, "needs_approval": 2}
    assert summary["by_risk"] == {"review": 2, "critical": 1}


def test_action_summary_scopes_by_customer_id(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "a", "review", "applied", customer_id="acme")
    log_action(conn, "apply_edit", "b", "review", "applied", customer_id="globex")

    assert action_summary(conn, customer_id="acme")["total_actions"] == 1
    assert action_summary(conn)["total_actions"] == 2


def test_top_tools_ranks_by_call_count(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    for _ in range(3):
        log_action(conn, "search", "x", "safe", "applied")
    log_action(conn, "run_command", "y", "critical", "needs_approval")

    ranked = top_tools(conn)

    assert ranked[0] == {"tool_name": "search", "count": 3}


def test_top_tools_respects_limit(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "a", "x", "safe", "applied")
    log_action(conn, "b", "x", "safe", "applied")
    log_action(conn, "c", "x", "safe", "applied")

    assert len(top_tools(conn, limit=2)) == 2


def test_daily_activity_groups_by_day(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "a", "review", "applied")
    log_action(conn, "apply_edit", "b", "review", "applied")

    activity = daily_activity(conn)

    assert len(activity) == 1  # both actions logged today
    assert activity[0]["count"] == 2


def test_daily_activity_excludes_actions_older_than_the_window(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    old_time = time.time() - 100 * 86400
    conn.execute(
        "INSERT INTO action_log (tool_name, description, risk, outcome, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ("apply_edit", "old", "review", "applied", None, old_time),
    )
    conn.commit()
    log_action(conn, "apply_edit", "recent", "review", "applied")

    activity = daily_activity(conn, days=30)

    assert sum(d["count"] for d in activity) == 1


def test_approval_rate_computes_fraction_that_proceeded(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    log_action(conn, "apply_edit", "a", "review", "applied")
    log_action(conn, "apply_edit", "b", "review", "applied")
    log_action(conn, "run_command", "c", "critical", "needs_approval")

    assert approval_rate(conn) == 2 / 3


def test_approval_rate_is_none_with_no_data(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    assert approval_rate(conn) is None


def test_customer_overview_combines_actions_and_conversation_turns(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    memory_conn = open_memory_store(str(tmp_path / "m.db"))

    log_action(conn, "apply_edit", "a", "review", "applied", customer_id="acme")
    log_action(conn, "apply_edit", "b", "review", "applied", customer_id="acme")
    record_turn(memory_conn, "acme", "user", "hi")
    record_turn(memory_conn, "globex", "user", "hi")  # no actions for globex, still shows up

    overview = customer_overview(conn, memory_conn)

    by_id = {c.customer_id: c for c in overview}
    assert by_id["acme"].action_count == 2
    assert by_id["acme"].conversation_turn_count == 1
    assert by_id["globex"].action_count == 0
    assert by_id["globex"].conversation_turn_count == 1

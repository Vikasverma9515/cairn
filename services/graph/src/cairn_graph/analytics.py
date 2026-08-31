"""Usage analytics — pillar 7 of the plan: "helps the company analyze
the customer, write the analytics, makes a dashboard to help company know
their product more."

This module is deliberately the data layer only, not a rendered
dashboard — a real dashboard UI is a separate frontend concern outside
this Python service's scope. What belongs here is: real SQL aggregations
over data this service already collects (the `action_log` table from
`store.py`, the `conversation_turns` table from `memory.py`), returned as
plain dicts a dashboard, a report, or another MCP tool can consume
without knowing anything about the schema underneath.

Every function is scoped by an optional `customer_id` — omit it for a
company-wide view across every customer, pass it for one customer's
usage. Same multi-tenant shape as `memory.py`.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass


def action_summary(conn: sqlite3.Connection, customer_id: str | None = None, since_days: int | None = None) -> dict:
    """Counts by outcome and by risk tier — the two numbers a company
    evaluating this product actually wants first: how much did the agent
    do, and how much of it needed a human. `since_days` narrows to a
    trailing window; omit for all-time."""
    where, params = _scope(customer_id, since_days)
    outcome_rows = conn.execute(
        f"SELECT outcome, COUNT(*) FROM action_log WHERE {where} GROUP BY outcome", params  # noqa: S608 — where is a fixed literal built from constants, params are bound
    ).fetchall()
    risk_rows = conn.execute(
        f"SELECT risk, COUNT(*) FROM action_log WHERE {where} GROUP BY risk", params  # noqa: S608
    ).fetchall()
    total = conn.execute(f"SELECT COUNT(*) FROM action_log WHERE {where}", params).fetchone()[0]  # noqa: S608
    return {
        "total_actions": total,
        "by_outcome": dict(outcome_rows),
        "by_risk": dict(risk_rows),
    }


def top_tools(conn: sqlite3.Connection, customer_id: str | None = None, limit: int = 10) -> list[dict]:
    """Which tools actually get used — the "what does this customer
    actually do with it" question, ranked by call count."""
    where, params = _scope(customer_id, None)
    rows = conn.execute(
        f"SELECT tool_name, COUNT(*) as n FROM action_log WHERE {where} GROUP BY tool_name ORDER BY n DESC LIMIT ?",  # noqa: S608
        (*params, limit),
    ).fetchall()
    return [{"tool_name": name, "count": count} for name, count in rows]


def daily_activity(conn: sqlite3.Connection, customer_id: str | None = None, days: int = 30) -> list[dict]:
    """One row per day with at least one action, oldest first — a real
    time series a sparkline can render directly, not padded with
    zero-activity days (a dashboard can decide how to fill gaps; this
    layer just reports what actually happened)."""
    since = time.time() - days * 86400
    where, params = _scope(customer_id, None)
    where = f"{where} AND created_at >= ?"
    rows = conn.execute(
        f"SELECT date(created_at, 'unixepoch') as day, COUNT(*) as n "  # noqa: S608
        f"FROM action_log WHERE {where} GROUP BY day ORDER BY day",
        (*params, since),
    ).fetchall()
    return [{"date": day, "count": count} for day, count in rows]


def approval_rate(conn: sqlite3.Connection, customer_id: str | None = None) -> float | None:
    """Fraction of gated decisions that actually proceeded (applied/ran)
    versus stopped for approval — the trust signal: a customer running
    mostly in review mode with a low approval rate is one still building
    confidence in auto mode, useful context for a customer-success team.
    None (not 0.0) when there's no data yet — a real "unknown" rather
    than a misleading zero."""
    where, params = _scope(customer_id, None)
    rows = conn.execute(f"SELECT outcome, COUNT(*) FROM action_log WHERE {where} GROUP BY outcome", params).fetchall()  # noqa: S608
    counts = dict(rows)
    total = sum(counts.values())
    if total == 0:
        return None
    proceeded = sum(v for k, v in counts.items() if k in ("applied", "ran"))
    return proceeded / total


@dataclass(frozen=True)
class CustomerActivity:
    customer_id: str
    action_count: int
    conversation_turn_count: int


def customer_overview(conn: sqlite3.Connection, memory_conn: sqlite3.Connection) -> list[CustomerActivity]:
    """One row per customer who has *either* taken an action or had a
    conversation turn recorded — the roster a company-facing dashboard
    starts from. Two separate connections because action_log lives in
    the graph db and conversation_turns lives in the memory db (see
    store.py / memory.py); a real deployment could point both at the
    same file, this function doesn't assume either way."""
    action_counts = dict(
        conn.execute(
            "SELECT customer_id, COUNT(*) FROM action_log WHERE customer_id IS NOT NULL GROUP BY customer_id"
        ).fetchall()
    )
    turn_counts = dict(
        memory_conn.execute("SELECT customer_id, COUNT(*) FROM conversation_turns GROUP BY customer_id").fetchall()
    )
    customer_ids = set(action_counts) | set(turn_counts)
    return [
        CustomerActivity(cid, action_counts.get(cid, 0), turn_counts.get(cid, 0))
        for cid in sorted(customer_ids)
    ]


def _scope(customer_id: str | None, since_days: int | None) -> tuple[str, tuple]:
    """Builds the WHERE clause + bound params shared by the per-customer,
    time-windowed queries above — one place to get right instead of four
    near-identical string-building blocks."""
    clauses = ["1=1"]
    params: list = []
    if customer_id is not None:
        clauses.append("customer_id = ?")
        params.append(customer_id)
    if since_days is not None:
        clauses.append("created_at >= ?")
        params.append(time.time() - since_days * 86400)
    return " AND ".join(clauses), tuple(params)

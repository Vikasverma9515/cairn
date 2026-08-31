"""Per-customer memory — pillar 6 of the plan ("self-learning for
individual customers, with memory"). Same storage shape as the rest of
this service: local SQLite, no new operational dependency, nothing that
leaves the customer's machine.

Two kinds of memory, deliberately kept separate:

- **Facts** (`memory_facts`) — durable, keyed preferences/observations
  ("prefers auto mode", "primary framework is Next.js") that should
  persist and get overwritten in place, not accumulate. `remember()` is
  an upsert on (customer_id, key), not an append-only log.
- **Conversation turns** (`conversation_turns`) — an append-only history
  per customer, the raw material an orchestrator reads back for session
  continuity ("what did we just talk about"), separate from the distilled
  facts above so a long conversation doesn't have to be re-summarized on
  every turn just to answer "what's this customer's permission mode
  preference."

Both are scoped by `customer_id` throughout — this is the multi-tenant
boundary. Every query takes one; there is no "get everyone's memory" path
by design, the same scoping discipline as `actions.py`'s path-escape
check for file operations.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

SCHEMA = """
CREATE TABLE IF NOT EXISTS memory_facts (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL,
  UNIQUE(customer_id, key)
);
CREATE INDEX IF NOT EXISTS idx_memory_facts_customer ON memory_facts(customer_id);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversation_turns_customer ON conversation_turns(customer_id, created_at);
"""


def open_memory_store(db_path: str) -> sqlite3.Connection:
    # check_same_thread=False — same reason as store.py's open_store: the
    # MCP server calls sync tools from a worker thread, not the thread
    # that opened this connection. Access is serialized by a lock at the
    # MCP layer (mcp_server.py's _lock), so this is safe.
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def remember(conn: sqlite3.Connection, customer_id: str, key: str, value: str) -> None:
    """Upsert, not append — a customer's "preferred permission mode" has
    one current value, not a history of every value it's ever held."""
    conn.execute(
        "INSERT INTO memory_facts (customer_id, key, value, updated_at) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(customer_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (customer_id, key, value, time.time()),
    )
    conn.commit()


def recall(conn: sqlite3.Connection, customer_id: str, key: str | None = None) -> dict[str, str]:
    """All facts for a customer, or just one key's value wrapped in a
    single-entry dict — kept uniform so callers don't need two code paths."""
    if key is not None:
        row = conn.execute(
            "SELECT value FROM memory_facts WHERE customer_id = ? AND key = ?", (customer_id, key)
        ).fetchone()
        return {key: row[0]} if row else {}
    rows = conn.execute("SELECT key, value FROM memory_facts WHERE customer_id = ?", (customer_id,)).fetchall()
    return {k: v for k, v in rows}


def forget(conn: sqlite3.Connection, customer_id: str, key: str) -> None:
    conn.execute("DELETE FROM memory_facts WHERE customer_id = ? AND key = ?", (customer_id, key))
    conn.commit()


@dataclass(frozen=True)
class Turn:
    role: str
    content: str
    created_at: float


def record_turn(conn: sqlite3.Connection, customer_id: str, role: str, content: str) -> None:
    conn.execute(
        "INSERT INTO conversation_turns (customer_id, role, content, created_at) VALUES (?, ?, ?, ?)",
        (customer_id, role, content, time.time()),
    )
    conn.commit()


def recent_history(conn: sqlite3.Connection, customer_id: str, limit: int = 20) -> list[Turn]:
    """Most recent turns, returned oldest-first — the order an LLM prompt
    actually wants them in, not the DESC order the query fetches them in."""
    rows = conn.execute(
        "SELECT role, content, created_at FROM conversation_turns WHERE customer_id = ? "
        "ORDER BY created_at DESC LIMIT ?",
        (customer_id, limit),
    ).fetchall()
    return [Turn(*row) for row in reversed(rows)]

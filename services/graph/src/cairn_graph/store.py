"""The structure graph's storage — local SQLite, on purpose.

Not a new operational dependency: Cairn's own dashboard already runs on
SQLite. Not a distributed store either — see the plan's note on Kythe's
Beam/Flink postprocessing pipeline becoming "practically unusable" at
large scale; a sharded, incrementally-synced *local* store is what the
fastest tools in this class (CodeGraph, 2026) actually ship, and it's
also what makes "never leaves the customer's machine" a fact instead of
a promise.

Checkpointing is the one thing this module is careful about: SQLite is
opened with WAL journaling and every incremental sync runs inside a
single transaction, committed once at the end — not once per file. That
mirrors a real regression another 2026 tool found and fixed: committing
every few megabytes stalls badly on network-mounted storage, which is
exactly what an enterprise install is likely to be running on.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path

from cairn_graph.extract import ExtractResult

SCHEMA = """
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  language TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  parse_status TEXT NOT NULL,
  error TEXT,
  indexed_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  exported INTEGER NOT NULL,
  parent TEXT
);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);

CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  names TEXT NOT NULL,
  is_relative INTEGER NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_source ON imports(source);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  caller TEXT,
  callee TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls(callee);
CREATE INDEX IF NOT EXISTS idx_calls_file ON calls(file_id);

CREATE TABLE IF NOT EXISTS framework_roots (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_framework_roots_name ON framework_roots(name);

CREATE TABLE IF NOT EXISTS references_ (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  referrer TEXT,
  name TEXT NOT NULL,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_references_name ON references_(name);

-- Every gated-action decision, not just the ones that ran — the record an
-- agentic product actually needs to be trustworthy to a company buying it:
-- not just "what did the agent change" but "what did it *try* to change,
-- and did a human have to approve it." Feeds both Month 5's analytics and
-- an eventual audit trail.
CREATE TABLE IF NOT EXISTS action_log (
  id INTEGER PRIMARY KEY,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  risk TEXT NOT NULL,
  outcome TEXT NOT NULL,
  customer_id TEXT,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_action_log_created ON action_log(created_at);
CREATE INDEX IF NOT EXISTS idx_action_log_customer ON action_log(customer_id);

-- What the vector index last embedded for each file, keyed by path (not
-- file_id — a changed file gets a fresh file_id on reindex, see
-- upsert_file's delete-then-reinsert, so path is the only stable key
-- across builds). Lets vectors.py skip re-embedding a file whose content
-- hasn't changed since it was last vectorized, the same incremental
-- lever build.py already applies to parsing.
CREATE TABLE IF NOT EXISTS vector_sync (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  embedded_at REAL NOT NULL
);
"""


@dataclass(frozen=True)
class FileRecord:
    id: int
    path: str
    content_hash: str
    parse_status: str


def open_store(db_path: str | Path) -> sqlite3.Connection:
    # check_same_thread=False: the MCP server runs each sync tool call on a
    # worker thread (anyio.to_thread.run_sync), not the thread that opened
    # this connection — found live when a real call_tool() invocation (not
    # just calling the plain functions directly, which every earlier test
    # did) crashed with sqlite3's default same-thread check. The MCP layer
    # serializes access with a lock (see mcp_server.py's _lock), so this
    # relaxation doesn't invite concurrent-write corruption.
    conn = sqlite3.connect(str(db_path), check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    # SQLite ignores every `ON DELETE CASCADE` in the schema unless this is
    # set on the connection — found by the deletion test failing silently
    # (files removed, their symbols left orphaned) until this was added.
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def existing_hashes(conn: sqlite3.Connection) -> dict[str, str]:
    """path -> content_hash for every file currently indexed — the whole
    incremental-sync decision (`skip this file, its hash hasn't changed`)
    is a single dict lookup against this, no per-file query."""
    rows = conn.execute("SELECT path, content_hash FROM files").fetchall()
    return {path: content_hash for path, content_hash in rows}


def upsert_file(
    conn: sqlite3.Connection,
    path: str,
    language: str,
    content_hash: str,
    parse_status: str,
    result: ExtractResult | None,
    error: str | None = None,
) -> None:
    """Replaces one file's rows in one transaction step — call sites batch
    many of these inside a single `with conn:` block (see build.py) so the
    whole incremental run commits once, not once per file."""
    existing = conn.execute("SELECT id FROM files WHERE path = ?", (path,)).fetchone()
    if existing is not None:
        conn.execute("DELETE FROM files WHERE id = ?", (existing[0],))  # cascades symbols/imports/calls

    cur = conn.execute(
        "INSERT INTO files (path, language, content_hash, parse_status, error, indexed_at) VALUES (?, ?, ?, ?, ?, ?)",
        (path, language, content_hash, parse_status, error, time.time()),
    )
    file_id = cur.lastrowid

    if result is None:
        return

    conn.executemany(
        "INSERT INTO symbols (file_id, kind, name, start_line, end_line, exported, parent) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [(file_id, s.kind, s.name, s.start_line, s.end_line, int(s.exported), s.parent) for s in result.symbols],
    )
    conn.executemany(
        "INSERT INTO imports (file_id, source, names, is_relative, line) VALUES (?, ?, ?, ?, ?)",
        [(file_id, i.source, json.dumps(list(i.names)), int(i.is_relative), i.line) for i in result.imports],
    )
    conn.executemany(
        "INSERT INTO calls (file_id, caller, callee, line) VALUES (?, ?, ?, ?)",
        [(file_id, c.caller, c.callee, c.line) for c in result.calls],
    )
    conn.executemany(
        "INSERT INTO framework_roots (file_id, name) VALUES (?, ?)",
        [(file_id, name) for name in result.framework_roots],
    )
    conn.executemany(
        "INSERT INTO references_ (file_id, referrer, name, line) VALUES (?, ?, ?, ?)",
        [(file_id, r.referrer, r.name, r.line) for r in result.references],
    )


def remove_file(conn: sqlite3.Connection, path: str) -> None:
    conn.execute("DELETE FROM files WHERE path = ?", (path,))


def log_action(
    conn: sqlite3.Connection,
    tool_name: str,
    description: str,
    risk: str,
    outcome: str,
    customer_id: str | None = None,
) -> int:
    """Called for every gated-action decision, whether it ran or stopped
    for approval — commits immediately (not batched) since actions happen
    one at a time, unlike the bulk build/upsert path in this module.
    Returns the new row's id — a "needs_approval" row's id becomes the
    request_id a caller must echo back to actually get approval honored;
    see `get_pending_action`/`resolve_action` below."""
    cursor = conn.execute(
        "INSERT INTO action_log (tool_name, description, risk, outcome, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (tool_name, description, risk, outcome, customer_id, time.time()),
    )
    conn.commit()
    return cursor.lastrowid


def get_pending_action(conn: sqlite3.Connection, request_id: int) -> ActionLogEntry | None:
    """Looks up a specific logged decision by id — used to verify an
    `approved=true` retry actually references a real prior
    `needs_approval` response instead of a guessed or reused id."""
    row = conn.execute(
        "SELECT id, tool_name, description, risk, outcome, customer_id, created_at FROM action_log WHERE id = ?",
        (request_id,),
    ).fetchone()
    return ActionLogEntry(*row) if row else None


def resolve_action(conn: sqlite3.Connection, request_id: int, outcome: str) -> None:
    """Flips a pending row to its resolved outcome in place, rather than
    inserting a second row — one request_id, one final state, so a
    duplicate approval attempt against an already-resolved id fails the
    "still pending" check in `get_pending_action`'s caller instead of
    silently re-running the action."""
    conn.execute("UPDATE action_log SET outcome = ? WHERE id = ?", (outcome, request_id))
    conn.commit()


@dataclass(frozen=True)
class ActionLogEntry:
    id: int
    tool_name: str
    description: str
    risk: str
    outcome: str
    customer_id: str | None
    created_at: float


def list_action_log(conn: sqlite3.Connection, limit: int = 50, customer_id: str | None = None) -> list[ActionLogEntry]:
    if customer_id is not None:
        rows = conn.execute(
            "SELECT id, tool_name, description, risk, outcome, customer_id, created_at FROM action_log "
            "WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?",
            (customer_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, tool_name, description, risk, outcome, customer_id, created_at FROM action_log "
            "ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [ActionLogEntry(*row) for row in rows]


def get_vector_sync_state(conn: sqlite3.Connection) -> dict[str, str]:
    """path -> content_hash last embedded — the vector-index counterpart
    to `existing_hashes()`, same shape, same purpose."""
    rows = conn.execute("SELECT path, content_hash FROM vector_sync").fetchall()
    return {path: content_hash for path, content_hash in rows}


def set_vector_sync_state(conn: sqlite3.Connection, path: str, content_hash: str) -> None:
    conn.execute(
        "INSERT INTO vector_sync (path, content_hash, embedded_at) VALUES (?, ?, ?) "
        "ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, embedded_at = excluded.embedded_at",
        (path, content_hash, time.time()),
    )


def remove_vector_sync_state(conn: sqlite3.Connection, path: str) -> None:
    conn.execute("DELETE FROM vector_sync WHERE path = ?", (path,))


def stats(conn: sqlite3.Connection) -> dict[str, int]:
    def count(table: str) -> int:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 — table is a fixed literal, never user input

    return {
        "files": count("files"),
        "symbols": count("symbols"),
        "imports": count("imports"),
        "calls": count("calls"),
        "failed_files": conn.execute("SELECT COUNT(*) FROM files WHERE parse_status = 'failed'").fetchone()[0],
        "generated_files_skipped": conn.execute("SELECT COUNT(*) FROM files WHERE parse_status = 'skipped_generated'").fetchone()[0],
    }

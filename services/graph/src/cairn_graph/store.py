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
"""


@dataclass(frozen=True)
class FileRecord:
    id: int
    path: str
    content_hash: str
    parse_status: str


def open_store(db_path: str | Path) -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path))
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


def remove_file(conn: sqlite3.Connection, path: str) -> None:
    conn.execute("DELETE FROM files WHERE path = ?", (path,))


def stats(conn: sqlite3.Connection) -> dict[str, int]:
    def count(table: str) -> int:
        return conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 — table is a fixed literal, never user input

    return {
        "files": count("files"),
        "symbols": count("symbols"),
        "imports": count("imports"),
        "calls": count("calls"),
        "failed_files": conn.execute("SELECT COUNT(*) FROM files WHERE parse_status != 'ok'").fetchone()[0],
    }

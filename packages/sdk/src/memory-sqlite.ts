// Phase 5 — real cross-session memory, backed by SQLite. Shape-inspired
// by (not copied from) Track B's services/graph/src/cairn_graph/memory.py
// (facts: an explicit upsert keyed by (scope, key); turns: append-only,
// recency-ordered recall, no search) — reimplemented here because Track
// B's version has no real tenant/scope isolation and wasn't built for
// Track A's actual runtime. Mirrors dashboard-sqlite.ts's own shape
// (file-or-shared-Database, a namespaced table, plain better-sqlite3) —
// the same real, already-shipped pattern, not a new one.
//
// `scopeId` is deliberately opaque and caller-supplied, never invented
// here: Track A has no existing identity concept anywhere (no userId/
// sessionId/tenantId in this SDK today — confirmed before writing this).
// A caller passes whatever it already has — a Cairn customer's own
// end-user id if they have login, or any other stable string they
// choose — and gets exactly the isolation that string implies. This
// store makes no claim about WHO a scope actually is.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const FACTS_TABLE = "cairn_memory_facts";
const TURNS_TABLE = "cairn_memory_turns";
const DEFAULT_RECENT_TURNS = 20;

export interface MemoryTurnRecord {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface MemoryStore {
  /** Explicit remember, upsert by (scopeId, key) — same as Track B's own "remember" being an explicit act, never automatic. */
  rememberFact(scopeId: string, key: string, value: string): void;
  recallFact(scopeId: string, key: string): string | null;
  /** Every fact for this scope, key -> value. */
  recallFacts(scopeId: string): Record<string, string>;
  /** Append-only — one row per turn, both roles. */
  recordTurn(scopeId: string, role: "user" | "assistant", content: string): void;
  /** Recency-ordered, oldest-first (ready to feed straight into a HistoryTurn[] array) — no search, matching Track B's own real capability, not an invented one. */
  recentTurns(scopeId: string, limit?: number): MemoryTurnRecord[];
}

/**
 * @param target Either a file path (opened/created, parent dir made if
 * needed) or an already-open better-sqlite3 `Database` — pass an open
 * connection to share it with your own tables instead of opening a second file.
 */
export function createSqliteMemoryStore(target: string | Database.Database): MemoryStore {
  const db = typeof target === "string" ? openFile(target) : target;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${FACTS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_id, key)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TURNS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${TURNS_TABLE}_scope ON ${TURNS_TABLE}(scope_id, id)`);

  const upsertFact = db.prepare(`
    INSERT INTO ${FACTS_TABLE} (scope_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const selectFact = db.prepare(`SELECT value FROM ${FACTS_TABLE} WHERE scope_id = ? AND key = ?`);
  const selectAllFacts = db.prepare(`SELECT key, value FROM ${FACTS_TABLE} WHERE scope_id = ?`);
  const insertTurn = db.prepare(`INSERT INTO ${TURNS_TABLE} (scope_id, role, content, created_at) VALUES (?, ?, ?, ?)`);
  const selectRecentTurns = db.prepare(`SELECT role, content, created_at FROM ${TURNS_TABLE} WHERE scope_id = ? ORDER BY id DESC LIMIT ?`);

  return {
    rememberFact(scopeId, key, value) {
      upsertFact.run(scopeId, key, value, new Date().toISOString());
    },
    recallFact(scopeId, key) {
      const row = selectFact.get(scopeId, key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    recallFacts(scopeId) {
      const rows = selectAllFacts.all(scopeId) as { key: string; value: string }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
    recordTurn(scopeId, role, content) {
      insertTurn.run(scopeId, role, content, new Date().toISOString());
    },
    recentTurns(scopeId, limit = DEFAULT_RECENT_TURNS) {
      const rows = selectRecentTurns.all(scopeId, limit) as { role: string; content: string; created_at: string }[];
      // DESC + LIMIT gets the N most recent, then reversed to oldest-first — ready to feed straight into a HistoryTurn[]-shaped array, same convention that array already uses.
      return rows.reverse().map((r) => ({ role: r.role as "user" | "assistant", content: r.content, createdAt: r.created_at }));
    },
  };
}

function openFile(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new Database(filePath);
}

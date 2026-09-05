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
import type { HistoryTurn } from "@cairnvibe/core";

const FACTS_TABLE = "cairn_memory_facts";
const TURNS_TABLE = "cairn_memory_turns";
const ARCHIVE_TABLE = "cairn_memory_archive";
const DEFAULT_RECENT_TURNS = 20;
const DEFAULT_SEARCH_LIMIT = 5;
// Architecture Pillar 5 — MemGPT-shaped tiered memory. A REAL, measured
// finding motivates this, not a hunch: swapping a tiered-memory agent for
// a flat/long-context-only one dropped multi-session task completion from
// ~80% to ~45% (MemoryArena, arxiv 2603.07670). Core is deliberately kept
// SMALL — "durable, curated facts, always injected" only means something
// if the set actually stays small; a scope that just accumulates facts
// forever isn't curated, it's a second, worse-organized turn log. Chosen
// as a real, testable number (not tuned against production data, which
// doesn't exist yet for this) — see this file's own tests for the exact
// eviction behavior at the boundary.
const MAX_CORE_FACTS_PER_SCOPE = 20;

export interface MemoryTurnRecord {
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

/** Real, significant (4+ letter) words, lowercased — the same crude but
 * dependency-free keyword-matching approach server.ts's Skill retrieval
 * (matchSkillByGoal) already established, reused here for the same
 * "cheap, deterministic, no new dependency" reasoning: no FTS5 extension
 * required, no semantic embedding call, just real substring matching
 * against words a human would actually recognize as meaningful. */
function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);
}

export interface MemoryStore {
  /** Core tier — explicit remember, upsert by (scopeId, key), same as
   * Track B's own "remember" being an explicit act, never automatic.
   * Kept small on purpose (MAX_CORE_FACTS_PER_SCOPE): once a scope's Core
   * facts exceed the cap, the least-recently-updated ones are moved to
   * the Archive tier below (see this file's own doc comment) rather than
   * deleted outright — "the piece that lets memory scale" the plan calls
   * for, not a data-loss cliff. */
  rememberFact(scopeId: string, key: string, value: string): void;
  recallFact(scopeId: string, key: string): string | null;
  /** Every CORE fact for this scope, key -> value — never includes Archive tier facts (see recallArchivedFacts for those). */
  recallFacts(scopeId: string): Record<string, string>;
  /** Recall tier — append-only, one row per turn, both roles. */
  recordTurn(scopeId: string, role: "user" | "assistant", content: string): void;
  /** Recall tier — recency-ordered, oldest-first (ready to feed straight into a HistoryTurn[] array). */
  recentTurns(scopeId: string, limit?: number): MemoryTurnRecord[];
  /**
   * Architecture Pillar 5 — the Recall tier's own real search: a keyword
   * match against past turn content, not just a recency LIMIT. Lets a
   * later question reach back further than `recentTurns`' own window
   * without loading the ENTIRE history every time. Recency-ordered
   * (newest match first) — no relevance ranking beyond "matched at all,"
   * a deliberately simple v1.
   */
  searchTurns(scopeId: string, query: string, limit?: number): MemoryTurnRecord[];
  /**
   * Architecture Pillar 5 — the Archive tier. Long-term facts pulled in
   * only when a real query actually relates to them, never always-
   * injected the way Core facts are (that's the whole point — this is
   * what lets memory scale past Core's small cap without either losing
   * old facts or paying to inject all of them on every single turn).
   * Populated automatically when `rememberFact` evicts an over-cap Core
   * fact; a caller may also archive something directly if it never
   * belonged in the small, always-injected Core set to begin with.
   */
  archiveFact(scopeId: string, key: string, value: string): void;
  /** Keyword match against BOTH key and value, recency-ordered. Empty object for no match — never guesses at relevance. */
  recallArchivedFacts(scopeId: string, query: string, limit?: number): Record<string, string>;
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${ARCHIVE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(scope_id, key)
    )
  `);

  const upsertFact = db.prepare(`
    INSERT INTO ${FACTS_TABLE} (scope_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const selectFact = db.prepare(`SELECT value FROM ${FACTS_TABLE} WHERE scope_id = ? AND key = ?`);
  const selectAllFacts = db.prepare(`SELECT key, value FROM ${FACTS_TABLE} WHERE scope_id = ?`);
  const countFacts = db.prepare(`SELECT COUNT(*) as count FROM ${FACTS_TABLE} WHERE scope_id = ?`);
  // ORDER BY updated_at, then id — a real tiebreaker: several facts
  // written in the same millisecond (easily happens in a tight loop, or
  // any two facts genuinely remembered together) would otherwise leave
  // "least-recently-updated" ambiguous, since SQLite makes no ordering
  // guarantee among rows with an equal ORDER BY key. Falling back to
  // insertion order (id) is the correct default when two facts are
  // equally "old" by their real timestamp.
  const selectOldestFacts = db.prepare(`SELECT key, value, updated_at FROM ${FACTS_TABLE} WHERE scope_id = ? ORDER BY updated_at ASC, id ASC LIMIT ?`);
  const deleteFact = db.prepare(`DELETE FROM ${FACTS_TABLE} WHERE scope_id = ? AND key = ?`);
  const insertTurn = db.prepare(`INSERT INTO ${TURNS_TABLE} (scope_id, role, content, created_at) VALUES (?, ?, ?, ?)`);
  const selectRecentTurns = db.prepare(`SELECT role, content, created_at FROM ${TURNS_TABLE} WHERE scope_id = ? ORDER BY id DESC LIMIT ?`);
  const upsertArchiveFact = db.prepare(`
    INSERT INTO ${ARCHIVE_TABLE} (scope_id, key, value, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);

  function archiveFactImpl(scopeId: string, key: string, value: string, updatedAt: string): void {
    upsertArchiveFact.run(scopeId, key, value, updatedAt);
  }

  /** Enforces MAX_CORE_FACTS_PER_SCOPE after a real write — moves the
   * least-recently-updated Core facts (oldest `updated_at` first) to
   * Archive instead of deleting them, until back at the cap. Never
   * evicts the fact that was just written (it's always the most
   * recently updated, so ORDER BY updated_at ASC naturally excludes it
   * as long as the cap is >= 1). */
  function enforceCoreCap(scopeId: string): void {
    const { count } = countFacts.get(scopeId) as { count: number };
    const overflow = count - MAX_CORE_FACTS_PER_SCOPE;
    if (overflow <= 0) return;
    const toEvict = selectOldestFacts.all(scopeId, overflow) as { key: string; value: string; updated_at: string }[];
    for (const row of toEvict) {
      archiveFactImpl(scopeId, row.key, row.value, row.updated_at);
      deleteFact.run(scopeId, row.key);
    }
  }

  return {
    rememberFact(scopeId, key, value) {
      upsertFact.run(scopeId, key, value, new Date().toISOString());
      enforceCoreCap(scopeId);
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
    searchTurns(scopeId, query, limit = DEFAULT_SEARCH_LIMIT) {
      const words = significantWords(query);
      if (words.length === 0) return [];
      const clause = words.map(() => "content LIKE ?").join(" OR ");
      const params = words.map((w) => `%${w}%`);
      const rows = db.prepare(`SELECT role, content, created_at FROM ${TURNS_TABLE} WHERE scope_id = ? AND (${clause}) ORDER BY id DESC LIMIT ?`).all(scopeId, ...params, limit) as {
        role: string;
        content: string;
        created_at: string;
      }[];
      return rows.reverse().map((r) => ({ role: r.role as "user" | "assistant", content: r.content, createdAt: r.created_at }));
    },
    archiveFact(scopeId, key, value) {
      archiveFactImpl(scopeId, key, value, new Date().toISOString());
    },
    recallArchivedFacts(scopeId, query, limit = DEFAULT_SEARCH_LIMIT) {
      const words = significantWords(query);
      if (words.length === 0) return {};
      const clause = words.map(() => "(key LIKE ? OR value LIKE ?)").join(" OR ");
      const params = words.flatMap((w) => [`%${w}%`, `%${w}%`]);
      const rows = db.prepare(`SELECT key, value FROM ${ARCHIVE_TABLE} WHERE scope_id = ? AND (${clause}) ORDER BY updated_at DESC LIMIT ?`).all(scopeId, ...params, limit) as {
        key: string;
        value: string;
      }[];
      return Object.fromEntries(rows.map((r) => [r.key, r.value]));
    },
  };
}

function openFile(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new Database(filePath);
}

/**
 * Phase 5 step 4 — pure, standalone, directly testable (no closures, no
 * DB, no WebSocket), storage-agnostic (works from a `MemoryStore`
 * however it's actually backed) — shared by BOTH transports (the
 * realtime relay, which seeds this once per connection, and the typed/
 * HTTP handler, which seeds it once per genuinely fresh session — see
 * server.ts's own use). Prior turns go FIRST (oldest overall), any
 * already-accumulated history stays after them, then the whole thing is
 * capped to `maxTurns` — same cap `history` itself already uses
 * everywhere else, just applied once more here so a scope with a long
 * real memory can't blow past it the moment a session starts.
 */
export function seedHistoryFromMemory(existingHistory: readonly HistoryTurn[], priorTurns: readonly MemoryTurnRecord[], maxTurns: number): HistoryTurn[] {
  const combined: HistoryTurn[] = [...priorTurns.map((t): HistoryTurn => ({ role: t.role, text: t.content })), ...existingHistory];
  return combined.slice(Math.max(0, combined.length - maxTurns));
}

/**
 * Phase 5 step 3 — closes the loop step 2 opened: a fact the model
 * explicitly remembered was being written but never read back into a
 * LATER turn's context, only `recentTurns`' raw conversation text
 * (unstructured, unreliable) had any chance of mentioning it. Pure and
 * standalone for the same reason as `seedHistoryFromMemory` — directly
 * testable with a plain object, no store, no connection. Returns null
 * for an empty fact set (nothing to say) rather than an empty string,
 * so a caller can cleanly skip adding a turn at all.
 */
export function formatRememberedFacts(facts: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(facts);
  if (entries.length === 0) return null;
  return `Remembered from a previous conversation with this user: ${entries.map(([key, value]) => `${key} — ${value}`).join("; ")}.`;
}

/**
 * Architecture Pillar 5 — the Archive tier's own version of
 * formatRememberedFacts, worded to make the tier distinction legible to
 * the model instead of silently blending long-since-archived facts in
 * with the small, always-injected Core set (the two ARE genuinely
 * different: Core is curated and small; this only ever shows up because
 * this exact turn's own question happened to relate to it). Same null-
 * for-empty discipline as its Core counterpart.
 */
export function formatArchivedFacts(facts: Readonly<Record<string, string>>): string | null {
  const entries = Object.entries(facts);
  if (entries.length === 0) return null;
  return `Also found in older, archived memory (relevant to this question): ${entries.map(([key, value]) => `${key} — ${value}`).join("; ")}.`;
}

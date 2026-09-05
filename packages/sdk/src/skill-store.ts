// Architecture Pillar 3 (Skill half) — real, persistent storage for
// self-authored Skills (packages/core/src/skills.ts), scoped by whatever
// opaque `scopeId` string the caller passes — same discipline as
// memory-sqlite.ts's own MemoryStore, but for a DIFFERENT axis of scope on
// purpose: a MemoryStore scopeId is per-user/session (today's usage,
// unchanged), while a SkillStore scopeId is meant to be per-DEPLOYMENT
// (the whole app, shared across every user who talks to it — the same
// scope ui-manifest.json itself already has). Nothing in this file
// enforces that distinction; it's the caller's own choice of scopeId that
// makes it true, exactly as MemoryStore's own doc comment already
// establishes for its scope.
//
// A dedicated table (not reusing memory-sqlite's facts table with a
// JSON-blob value) specifically so `listSkillSummaries` can select just
// id/name/description/pattern at the SQL level — the real mechanism
// behind "progressive disclosure stays cheap": a deployment with many
// learned Skills never pays to load every Skill's full instructions just
// to list what's available, only the one a caller actually requests via
// getSkill.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Skill, SkillSummary } from "@cairnvibe/core";

const SKILLS_TABLE = "cairn_skills";

export interface SkillStore {
  /** Upserts by (scopeId, id) — a re-learned Skill for the same real capability replaces the old one, never accumulates duplicates. */
  saveSkill(scopeId: string, skill: Skill): void;
  /** Cheap: id/name/description/pattern only, never the full instructions — see this file's own doc comment. */
  listSkillSummaries(scopeId: string): SkillSummary[];
  /** The one Skill a caller actually matched — full instructions included. Null if this scope has no Skill with that id. */
  getSkill(scopeId: string, id: string): Skill | null;
}

/**
 * @param target Either a file path (opened/created, parent dir made if
 * needed) or an already-open better-sqlite3 `Database` — pass an open
 * connection to share it with your own tables (or memory-sqlite.ts's own
 * store) instead of opening a second file.
 */
export function createSqliteSkillStore(target: string | Database.Database): SkillStore {
  const db = typeof target === "string" ? openFile(target) : target;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SKILLS_TABLE} (
      scope_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      pattern TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope_id, id)
    )
  `);

  const upsertSkill = db.prepare(`
    INSERT INTO ${SKILLS_TABLE} (scope_id, id, name, description, instructions, pattern, created_at)
    VALUES (@scopeId, @id, @name, @description, @instructions, @pattern, @createdAt)
    ON CONFLICT(scope_id, id) DO UPDATE SET
      name = excluded.name, description = excluded.description, instructions = excluded.instructions,
      pattern = excluded.pattern, created_at = excluded.created_at
  `);
  const selectSummaries = db.prepare(`SELECT id, name, description, pattern FROM ${SKILLS_TABLE} WHERE scope_id = ?`);
  const selectSkill = db.prepare(`SELECT id, name, description, instructions, pattern, created_at FROM ${SKILLS_TABLE} WHERE scope_id = ? AND id = ?`);

  return {
    saveSkill(scopeId, skill) {
      upsertSkill.run({ scopeId, id: skill.id, name: skill.name, description: skill.description, instructions: skill.instructions, pattern: skill.pattern ?? null, createdAt: skill.createdAt });
    },
    listSkillSummaries(scopeId) {
      const rows = selectSummaries.all(scopeId) as { id: string; name: string; description: string; pattern: string | null }[];
      return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, pattern: r.pattern ?? undefined }));
    },
    getSkill(scopeId, id) {
      const row = selectSkill.get(scopeId, id) as { id: string; name: string; description: string; instructions: string; pattern: string | null; created_at: string } | undefined;
      if (!row) return null;
      return { id: row.id, name: row.name, description: row.description, instructions: row.instructions, pattern: row.pattern ?? undefined, createdAt: row.created_at };
    },
  };
}

function openFile(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new Database(filePath);
}

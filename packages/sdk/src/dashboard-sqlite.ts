// A real, durable MissesStore — same interface as the in-memory default in
// dashboard.ts, but backed by SQLite so failure-dashboard data survives
// restarts and redeploys. This is what "swap for a real one" (dashboard.ts)
// actually looks like, not a toy.

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { MissesStore, MissRecord } from "./dashboard";

// Namespaced (not just "misses") so this can safely share a Database
// connection/file with a consumer's own tables (the demo app does this).
const TABLE = "cairn_misses";

/**
 * @param target Either a file path (opened/created, parent dir made if
 * needed) or an already-open better-sqlite3 `Database` — pass an open
 * connection to share it with your own tables instead of opening a second file.
 */
export function createSqliteMissesStore(target: string | Database.Database): MissesStore {
  const db = typeof target === "string" ? openFile(target) : target;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attempted TEXT NOT NULL,
      route TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `);

  const insert = db.prepare(`INSERT INTO ${TABLE} (attempted, route, at) VALUES (?, ?, ?)`);
  const selectAll = db.prepare(`SELECT attempted, route, at FROM ${TABLE} ORDER BY id ASC`);
  const deleteAll = db.prepare(`DELETE FROM ${TABLE}`);

  return {
    report(context) {
      insert.run(context.attempted, context.route, new Date().toISOString());
    },
    list() {
      return selectAll.all() as MissRecord[];
    },
    clear() {
      deleteAll.run();
    },
  };
}

function openFile(filePath: string): Database.Database {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return new Database(filePath);
}

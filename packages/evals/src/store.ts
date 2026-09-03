// Durable eval history — every run's scenario, full trace, verdict, git
// commit, and timestamp, so a regression is a real, visible diff against
// the previous commit's run instead of something nobody notices until a
// user hits it. Same shape/pattern as packages/sdk/src/dashboard-sqlite.ts.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ScenarioRunResult } from "./trace";
import type { Verdict } from "./judge";

const TABLE = "eval_runs";

export interface StoredRun {
  id: number;
  scenarioId: string;
  transport: string;
  commit: string;
  ranAt: string;
  verdict: Verdict;
  result: ScenarioRunResult;
}

export function openStore(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scenario_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      ran_at TEXT NOT NULL,
      verdict TEXT NOT NULL,
      result TEXT NOT NULL
    )
  `);
  return db;
}

export function recordRun(db: Database.Database, commit: string, result: ScenarioRunResult, verdict: Verdict): void {
  db.prepare(`INSERT INTO ${TABLE} (scenario_id, transport, commit_sha, ran_at, verdict, result) VALUES (?, ?, ?, ?, ?, ?)`).run(
    result.scenarioId,
    result.transport,
    commit,
    new Date().toISOString(),
    JSON.stringify(verdict),
    JSON.stringify(result),
  );
}

function rowToRun(row: any): StoredRun {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    transport: row.transport,
    commit: row.commit_sha,
    ranAt: row.ran_at,
    verdict: JSON.parse(row.verdict),
    result: JSON.parse(row.result),
  };
}

/** The most recent run for this scenario+transport, from a commit OTHER
 * than `excludeCommit` (the run in progress) — what the CLI diffs the new
 * score against. */
export function previousRun(db: Database.Database, scenarioId: string, transport: string, excludeCommit: string): StoredRun | null {
  const row = db
    .prepare(
      `SELECT * FROM ${TABLE} WHERE scenario_id = ? AND transport = ? AND commit_sha != ? ORDER BY id DESC LIMIT 1`,
    )
    .get(scenarioId, transport, excludeCommit);
  return row ? rowToRun(row) : null;
}

export function allRuns(db: Database.Database): StoredRun[] {
  return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY id ASC`).all() as any[]).map(rowToRun);
}

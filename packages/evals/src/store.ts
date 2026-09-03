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
  /** Groups the k trials of one pass^k evaluation together — a fresh id
   * per `runScenarioRepeated` call (runner.ts), shared across its k rows,
   * distinct from a plain one-off run's own id. */
  trialGroup: string;
  /** 1-indexed position within its trial group. */
  trialIndex: number;
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
      result TEXT NOT NULL,
      trial_group TEXT NOT NULL,
      trial_index INTEGER NOT NULL
    )
  `);
  return db;
}

export function recordRun(
  db: Database.Database,
  commit: string,
  result: ScenarioRunResult,
  verdict: Verdict,
  trial: { group: string; index: number },
): void {
  db.prepare(
    `INSERT INTO ${TABLE} (scenario_id, transport, commit_sha, ran_at, verdict, result, trial_group, trial_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(result.scenarioId, result.transport, commit, new Date().toISOString(), JSON.stringify(verdict), JSON.stringify(result), trial.group, trial.index);
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
    trialGroup: row.trial_group,
    trialIndex: row.trial_index,
  };
}

/** The most recent COMPLETE trial group for this scenario+transport, from
 * a commit OTHER than `excludeCommit` (the run in progress) — what the CLI
 * diffs the new pass^k/scores against. "Complete" matters: a group cut
 * short by a crash shouldn't silently look like a worse (or better) k. */
export function previousTrialGroup(db: Database.Database, scenarioId: string, transport: string, excludeCommit: string): StoredRun[] {
  const latestGroup = db
    .prepare(
      `SELECT trial_group FROM ${TABLE} WHERE scenario_id = ? AND transport = ? AND commit_sha != ? ORDER BY id DESC LIMIT 1`,
    )
    .get(scenarioId, transport, excludeCommit) as { trial_group: string } | undefined;
  if (!latestGroup) return [];
  return trialGroupResults(db, latestGroup.trial_group);
}

/** Every trial recorded under one pass^k group, in run order. */
export function trialGroupResults(db: Database.Database, trialGroup: string): StoredRun[] {
  return (db.prepare(`SELECT * FROM ${TABLE} WHERE trial_group = ? ORDER BY trial_index ASC`).all(trialGroup) as any[]).map(rowToRun);
}

export function allRuns(db: Database.Database): StoredRun[] {
  return (db.prepare(`SELECT * FROM ${TABLE} ORDER BY id ASC`).all() as any[]).map(rowToRun);
}

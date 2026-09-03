// Server-only data access — reads @cairnvibe/evals's own SQLite run
// history directly (no separate API layer; this is a small internal tool
// reading a file its sibling package already writes). Resolves the db path
// relative to the evals package by convention (this dashboard is meant to
// run alongside it in the same checkout), overridable via env for anyone
// running it against a different location.
import path from "node:path";
import { openStore, allRuns, trialGroupResults, type StoredRun } from "@cairnvibe/evals/store";
import { scenarios } from "@cairnvibe/evals/scenarios";
import { CAPABILITY_TAGS, type CapabilityTag } from "@cairnvibe/evals/taxonomy";
import type Database from "better-sqlite3";

function resolveDbPath(): string {
  if (process.env.CAIRN_EVALS_DB_PATH) return process.env.CAIRN_EVALS_DB_PATH;
  return path.join(process.cwd(), "..", "evals", "data", "evals.db");
}

let dbInstance: Database.Database | null = null;
function getDb(): Database.Database {
  if (!dbInstance) dbInstance = openStore(resolveDbPath());
  return dbInstance;
}

export interface TrialGroupSummary {
  trialGroup: string;
  commit: string;
  ranAt: string;
  passAtK: boolean;
  trialCount: number;
}

export interface ScenarioGroupSummary {
  scenarioId: string;
  scenarioName: string;
  capabilities: CapabilityTag[];
  transport: string;
  latestTrialGroup: string;
  latestRuns: StoredRun[];
  latestCommit: string;
  latestRanAt: string;
  passAtK: boolean;
  /** Every trial group ever recorded for this scenario+transport, oldest
   * first — the sparkline's real source, not a placeholder. */
  history: TrialGroupSummary[];
}

/** One row per (scenario, transport) pair, carrying its most recent trial
 * group plus the full history needed for a pass/fail sparkline. Grouping
 * happens here, once, so both the scenario list and the capability
 * breakdown read the same real aggregation. */
export function getScenarioSummaries(): ScenarioGroupSummary[] {
  const runs = allRuns(getDb()); // ascending by id — oldest first

  const byKey = new Map<string, StoredRun[]>();
  for (const run of runs) {
    const key = `${run.scenarioId}::${run.transport}`;
    const existing = byKey.get(key);
    if (existing) existing.push(run);
    else byKey.set(key, [run]);
  }

  const summaries: ScenarioGroupSummary[] = [];
  for (const [key, keyRuns] of byKey) {
    const sepIndex = key.lastIndexOf("::");
    const scenarioId = key.slice(0, sepIndex);
    const transport = key.slice(sepIndex + 2);
    const scenario = scenarios.find((s) => s.id === scenarioId);

    const groupOrder: string[] = [];
    const byGroup = new Map<string, StoredRun[]>();
    for (const run of keyRuns) {
      const existing = byGroup.get(run.trialGroup);
      if (existing) existing.push(run);
      else {
        byGroup.set(run.trialGroup, [run]);
        groupOrder.push(run.trialGroup);
      }
    }

    const history: TrialGroupSummary[] = groupOrder.map((trialGroup) => {
      const groupRuns = byGroup.get(trialGroup)!;
      return {
        trialGroup,
        commit: groupRuns[0].commit,
        ranAt: groupRuns[groupRuns.length - 1].ranAt,
        passAtK: groupRuns.length > 0 && groupRuns.every((r) => r.verdict.pass),
        trialCount: groupRuns.length,
      };
    });
    const latest = history[history.length - 1];

    summaries.push({
      scenarioId,
      scenarioName: scenario?.name ?? scenarioId,
      capabilities: scenario?.capabilities ?? [],
      transport,
      latestTrialGroup: latest.trialGroup,
      latestRuns: byGroup.get(latest.trialGroup)!,
      latestCommit: latest.commit,
      latestRanAt: latest.ranAt,
      passAtK: latest.passAtK,
      history,
    });
  }

  summaries.sort((a, b) => a.scenarioName.localeCompare(b.scenarioName) || a.transport.localeCompare(b.transport));
  return summaries;
}

export function getTrialGroup(trialGroup: string): StoredRun[] {
  return trialGroupResults(getDb(), trialGroup);
}

export interface CapabilityBreakdownRow {
  tag: CapabilityTag;
  passed: number;
  total: number;
}

/** Aggregate pass^k rate per taxonomy dimension, counting each scenario's
 * MOST RECENT trial group once — the direct answer to "how good are we at
 * X capability" that the whole taxonomy exists to make measurable. */
export function getCapabilityBreakdown(): CapabilityBreakdownRow[] {
  const summaries = getScenarioSummaries();
  const tally = new Map<CapabilityTag, CapabilityBreakdownRow>();
  for (const tag of CAPABILITY_TAGS) tally.set(tag, { tag, passed: 0, total: 0 });

  for (const summary of summaries) {
    for (const tag of summary.capabilities) {
      const row = tally.get(tag)!;
      row.total++;
      if (summary.passAtK) row.passed++;
    }
  }
  return CAPABILITY_TAGS.map((tag) => tally.get(tag)!);
}

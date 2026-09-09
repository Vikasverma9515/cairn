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

export interface RecentVerdict {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  trialGroup: string;
  pass: boolean;
  taskSuccess: number;
  reasoning: string;
  ranAt: string;
}

/** The most recent judged trial (one per scenario+transport, its own
 * MOST RECENT trial group, first trial of it) with the judge's real
 * reasoning attached — direct answer to "what did the agent do, and what
 * did the model that scored it actually say" without opening a trace. */
export function getRecentVerdicts(limit = 8): RecentVerdict[] {
  const summaries = getScenarioSummaries();
  const withRuns = summaries.filter((s) => s.latestRuns.length > 0);
  withRuns.sort((a, b) => b.latestRanAt.localeCompare(a.latestRanAt));
  return withRuns.slice(0, limit).map((s) => {
    const run = s.latestRuns[0];
    return {
      scenarioId: s.scenarioId,
      scenarioName: s.scenarioName,
      transport: s.transport,
      trialGroup: s.latestTrialGroup,
      pass: run.verdict.pass,
      taskSuccess: run.verdict.taskSuccess,
      reasoning: run.verdict.reasoning,
      ranAt: run.ranAt,
    };
  });
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

export interface CommitInfo {
  commit: string;
  /** Most recent ran_at among this commit's runs — what the picker sorts by. */
  ranAt: string;
}

/** Every distinct commit with recorded runs, most recent first — the
 * comparison view's picker options. */
export function getCommits(): CommitInfo[] {
  const runs = allRuns(getDb());
  const latestByCommit = new Map<string, string>();
  for (const run of runs) {
    const prev = latestByCommit.get(run.commit);
    if (!prev || run.ranAt > prev) latestByCommit.set(run.commit, run.ranAt);
  }
  return Array.from(latestByCommit.entries())
    .map(([commit, ranAt]) => ({ commit, ranAt }))
    .sort((a, b) => b.ranAt.localeCompare(a.ranAt));
}

export interface CommitScenarioStat {
  trialGroup: string;
  passAtK: boolean;
  trialCount: number;
  avgTaskSuccess: number;
  avgEfficiency: number;
  avgCorrectness: number;
  avgSafety: number;
  avgLatency: number | null;
}

function statsForCommit(runs: StoredRun[], scenarioId: string, transport: string, commit: string): CommitScenarioStat | null {
  const matching = runs.filter((r) => r.scenarioId === scenarioId && r.transport === transport && r.commit === commit);
  if (matching.length === 0) return null;
  // A commit can carry more than one trial group for the same scenario
  // (re-run by hand) — take the most recent one, same "latest wins" rule
  // the scenario list uses.
  const latestGroup = matching.reduce((latest, r) => (r.id > latest.id ? r : latest), matching[0]).trialGroup;
  const groupRuns = matching.filter((r) => r.trialGroup === latestGroup);
  const avg = (select: (r: StoredRun) => number) => groupRuns.reduce((sum, r) => sum + select(r), 0) / groupRuns.length;
  const latencies = groupRuns.map((r) => r.verdict.latency).filter((v): v is number => v !== null);
  return {
    trialGroup: latestGroup,
    passAtK: groupRuns.every((r) => r.verdict.pass),
    trialCount: groupRuns.length,
    avgTaskSuccess: avg((r) => r.verdict.taskSuccess),
    avgEfficiency: avg((r) => r.verdict.efficiency),
    avgCorrectness: avg((r) => r.verdict.correctness),
    avgSafety: avg((r) => r.verdict.safety),
    avgLatency: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
  };
}

export interface ComparisonRow {
  scenarioId: string;
  scenarioName: string;
  transport: string;
  a: CommitScenarioStat | null;
  b: CommitScenarioStat | null;
  /** "regressed" when b newly fails pass^k or its taskSuccess drops
   * noticeably vs a — the direct "regression detection highlighted"
   * requirement from the plan's comparison-view spec. */
  status: "regressed" | "improved" | "unchanged" | "new-in-b" | "missing-in-b";
}

const REGRESSION_THRESHOLD = 0.15;

function compareStatus(a: CommitScenarioStat | null, b: CommitScenarioStat | null): ComparisonRow["status"] {
  if (!a && b) return "new-in-b";
  if (a && !b) return "missing-in-b";
  if (!a || !b) return "unchanged";
  if (a.passAtK && !b.passAtK) return "regressed";
  if (!a.passAtK && b.passAtK) return "improved";
  const delta = b.avgTaskSuccess - a.avgTaskSuccess;
  if (delta <= -REGRESSION_THRESHOLD) return "regressed";
  if (delta >= REGRESSION_THRESHOLD) return "improved";
  return "unchanged";
}

export interface DimensionAverages {
  taskSuccess: number;
  efficiency: number;
  correctness: number;
  safety: number;
  latency: number | null;
  persona: number | null;
  policyCompliance: number | null;
}

export interface RunSummary {
  commit: string;
  /** The latest ran_at among this commit's rows — when this run finished. */
  ranAt: string;
  /** 0-100 — the four dimensions every verdict always carries
   * (taskSuccess/efficiency/correctness/safety), averaged then scaled.
   * latency/persona/policyCompliance are real but only apply to a subset
   * of runs (voice-only, policy-constraint-only) — shown alongside, never
   * folded into the headline number, so a suite with few voice/policy
   * scenarios isn't penalized for dimensions that don't apply to it. */
  overallScore: number;
  /** Fraction of scenario×transport groups that passed pass^k under this commit. */
  passRate: number;
  scenarioGroupCount: number;
  dimensionAverages: DimensionAverages;
}

function avgOrNull(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v !== null);
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
}

/** One row per commit that has recorded runs — the real, run-over-run
 * trend: overall score, pass rate, and the full dimension breakdown, so
 * "did we actually get better" has one real number to point at instead of
 * a wall of individual scenario pass/fails. Oldest first (a trend chart's
 * natural reading order). */
export function getRunSummaries(): RunSummary[] {
  const runs = allRuns(getDb());
  const byCommit = new Map<string, StoredRun[]>();
  for (const run of runs) {
    const existing = byCommit.get(run.commit);
    if (existing) existing.push(run);
    else byCommit.set(run.commit, [run]);
  }

  const summaries: RunSummary[] = [];
  for (const [commit, commitRuns] of byCommit) {
    const byGroup = new Map<string, StoredRun[]>();
    for (const r of commitRuns) {
      const key = `${r.scenarioId}::${r.transport}::${r.trialGroup}`;
      const existing = byGroup.get(key);
      if (existing) existing.push(r);
      else byGroup.set(key, [r]);
    }
    let passed = 0;
    for (const groupRuns of byGroup.values()) {
      if (groupRuns.every((r) => r.verdict.pass)) passed++;
    }

    const verdicts = commitRuns.map((r) => r.verdict);
    const dimensionAverages: DimensionAverages = {
      taskSuccess: avgOrNull(verdicts.map((v) => v.taskSuccess)) ?? 0,
      efficiency: avgOrNull(verdicts.map((v) => v.efficiency)) ?? 0,
      correctness: avgOrNull(verdicts.map((v) => v.correctness)) ?? 0,
      safety: avgOrNull(verdicts.map((v) => v.safety)) ?? 0,
      latency: avgOrNull(verdicts.map((v) => v.latency)),
      persona: avgOrNull(verdicts.map((v) => v.persona)),
      policyCompliance: avgOrNull(verdicts.map((v) => v.policyCompliance)),
    };
    const core = [dimensionAverages.taskSuccess, dimensionAverages.efficiency, dimensionAverages.correctness, dimensionAverages.safety];
    const overallScore = Math.round((core.reduce((a, b) => a + b, 0) / core.length) * 100);
    const ranAt = commitRuns.reduce((latest, r) => (r.ranAt > latest ? r.ranAt : latest), commitRuns[0].ranAt);

    summaries.push({ commit, ranAt, overallScore, passRate: byGroup.size ? passed / byGroup.size : 0, scenarioGroupCount: byGroup.size, dimensionAverages });
  }

  summaries.sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  return summaries;
}

export interface GoldenScenario {
  id: string;
  name: string;
  goal: string;
  capabilities: CapabilityTag[];
  transports: string[];
  rubricNotes: string | null;
  /** The real pass criteria (scenario.verify) — what the app's own real
   * state must contain for this to count as achieved. This IS the golden
   * answer: not a guess, the literal string(s) checked against
   * scenario.verify.path after the run, independent of anything the
   * judge or the agent claims. */
  expectContains: string[];
  policyConstraint: string | null;
}

/** The golden dataset itself, straight from the real scenario fixtures
 * (@cairnvibe/evals/scenarios) — never derived from run history, so this
 * lists what's EVALUATED regardless of whether it's ever been run yet. */
export function getGoldenDataset(): GoldenScenario[] {
  return scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    goal: s.goal,
    capabilities: s.capabilities,
    transports: s.transports ?? ["typed", "voice"],
    rubricNotes: s.rubricNotes ?? null,
    expectContains: Array.isArray(s.verify.expectContains) ? s.verify.expectContains : [s.verify.expectContains],
    policyConstraint: s.policyConstraint ?? null,
  }));
}

/** Side-by-side score/latency diff per scenario between two commits, with
 * regressions flagged — the plan's comparison-view spec. */
export function getComparisonRows(commitA: string, commitB: string): ComparisonRow[] {
  const runs = allRuns(getDb());
  const pairKeys = new Set<string>();
  for (const run of runs) {
    if (run.commit === commitA || run.commit === commitB) pairKeys.add(`${run.scenarioId}::${run.transport}`);
  }

  const rows: ComparisonRow[] = [];
  for (const key of pairKeys) {
    const sepIndex = key.lastIndexOf("::");
    const scenarioId = key.slice(0, sepIndex);
    const transport = key.slice(sepIndex + 2);
    const scenario = scenarios.find((s) => s.id === scenarioId);
    const a = statsForCommit(runs, scenarioId, transport, commitA);
    const b = statsForCommit(runs, scenarioId, transport, commitB);
    rows.push({ scenarioId, scenarioName: scenario?.name ?? scenarioId, transport, a, b, status: compareStatus(a, b) });
  }

  rows.sort((x, y) => x.scenarioName.localeCompare(y.scenarioName) || x.transport.localeCompare(y.transport));
  return rows;
}

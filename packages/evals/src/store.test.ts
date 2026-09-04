import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allRuns, openStore, previousTrialGroup, recordRun, trialGroupResults } from "./store";
import type { Verdict } from "./judge";
import type { ScenarioRunResult } from "./trace";
import type Database from "better-sqlite3";

function fakeResult(scenarioId: string, transport: "typed" | "voice" = "typed"): ScenarioRunResult {
  return { scenarioId, transport, startedAt: new Date().toISOString(), finalState: {}, achieved: true, copilotRoundTrips: [] };
}

function fakeVerdict(pass: boolean): Verdict {
  return { taskSuccess: pass ? 1 : 0, efficiency: 0.8, correctness: 1, safety: 1, latency: null, persona: null, policyCompliance: null, reasoning: "test", pass };
}

describe("store — trial groups and pass^k history", () => {
  let db: Database.Database;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cairn-evals-test-")), "evals.db");
    db = openStore(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
  });

  it("real bug this guards against: trials from the SAME group must not be mistaken for the previous commit's group", () => {
    // Two trials of the same scenario, same commit, same trial group.
    recordRun(db, "commit-a", fakeResult("s1"), fakeVerdict(true), { group: "group-1", index: 1 });
    recordRun(db, "commit-a", fakeResult("s1"), fakeVerdict(true), { group: "group-1", index: 2 });

    const results = trialGroupResults(db, "group-1");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.trialIndex)).toEqual([1, 2]);
  });

  it("previousTrialGroup finds the most recent group from a DIFFERENT commit, never the in-progress one", () => {
    recordRun(db, "commit-a", fakeResult("s1"), fakeVerdict(true), { group: "group-old", index: 1 });
    recordRun(db, "commit-a", fakeResult("s1"), fakeVerdict(false), { group: "group-old", index: 2 });
    // The in-progress commit's own trials — must be excluded from "previous".
    recordRun(db, "commit-b", fakeResult("s1"), fakeVerdict(true), { group: "group-new", index: 1 });

    const prev = previousTrialGroup(db, "s1", "typed", "commit-b");
    expect(prev.map((r) => r.trialGroup)).toEqual(["group-old", "group-old"]);
    expect(prev).toHaveLength(2);
  });

  it("previousTrialGroup returns empty for a scenario with no prior history — not a crash", () => {
    expect(previousTrialGroup(db, "never-run-before", "typed", "commit-a")).toEqual([]);
  });

  it("keeps typed and voice trial groups for the same scenario id fully separate", () => {
    recordRun(db, "commit-a", fakeResult("s1", "typed"), fakeVerdict(true), { group: "g-typed", index: 1 });
    recordRun(db, "commit-a", fakeResult("s1", "voice"), fakeVerdict(false), { group: "g-voice", index: 1 });

    expect(previousTrialGroup(db, "s1", "typed", "commit-b")).toHaveLength(1);
    expect(previousTrialGroup(db, "s1", "voice", "commit-b")).toHaveLength(1);
    expect(previousTrialGroup(db, "s1", "typed", "commit-b")[0].verdict.pass).toBe(true);
    expect(previousTrialGroup(db, "s1", "voice", "commit-b")[0].verdict.pass).toBe(false);
  });

  it("allRuns returns every stored trial across every group, oldest first", () => {
    recordRun(db, "commit-a", fakeResult("s1"), fakeVerdict(true), { group: "g1", index: 1 });
    recordRun(db, "commit-a", fakeResult("s2"), fakeVerdict(false), { group: "g2", index: 1 });
    expect(allRuns(db).map((r) => r.scenarioId)).toEqual(["s1", "s2"]);
  });
});

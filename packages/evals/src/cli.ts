#!/usr/bin/env node
// `npm run evals` — runs the real scenario suite against a real running
// playground app, judges each run with Claude, stores every trial, and
// prints a pass^k summary plus a score/latency diff against the previous
// commit's trial group of the same scenario. This is what runs before any
// future publish, per the eval plan — closing the exact gap that let a
// voice regression ship unnoticed.
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runScenarioRepeated, type RunnerOptions } from "./runner";
import { judgeScenario, passAtK, type Verdict } from "./judge";
import { openStore, previousTrialGroup, recordRun } from "./store";
import { scenarios } from "./scenarios";
import type { Transport } from "./scenario";
import { runBargeInProbe } from "./barge-in-probes";

function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: process.cwd() }).toString().trim();
  } catch {
    return "unknown";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`cairn-evals: ${name} is not set — export it and re-run.`);
    process.exit(1);
  }
  return value;
}

function fmt(n: number | null): string {
  return n === null ? "-" : n.toFixed(2);
}

function avg(values: (number | null)[]): number | null {
  const real = values.filter((v): v is number => v !== null);
  return real.length ? real.reduce((a, b) => a + b, 0) / real.length : null;
}

function diffLine(label: string, before: number | null, after: number | null): string {
  if (before === null) return `${label}: ${fmt(after)} (no previous run)`;
  const delta = after === null ? null : after - before;
  const arrow = delta === null ? "" : delta > 0.01 ? " ▲" : delta < -0.01 ? " ▼" : " =";
  return `${label}: ${fmt(after)} (was ${fmt(before)}${delta !== null ? `, ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}` : ""})${arrow}`;
}

async function main(): Promise<void> {
  const deepgramApiKey = requireEnv("DEEPGRAM_API_KEY");
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const commit = currentCommit();
  const dbPath = path.join(process.cwd(), "data", "evals.db");
  const db = openStore(dbPath);
  // Default k=3 (τ-bench-style pass^k, research item #5) — override with
  // CAIRN_EVALS_K=1 for fast iteration during dev; full reliability
  // checking is what should run before a publish.
  const k = Number(process.env.CAIRN_EVALS_K ?? "3") || 3;

  const runnerOptions: RunnerOptions = { deepgramApiKey, anthropicApiKey, headless: process.env.CAIRN_EVALS_HEADED !== "1" };

  let totalGroups = 0;
  let totalPassedAtK = 0;

  for (const scenario of scenarios) {
    const transports: Transport[] = scenario.transports ?? ["typed", "voice"];
    for (const transport of transports) {
      totalGroups++;
      process.stdout.write(`\n${scenario.name} [${transport}] (${k}x) ... `);
      const trialGroup = randomUUID();
      const results = await runScenarioRepeated(scenario, transport, k, runnerOptions);

      const verdicts: Verdict[] = [];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.runError) {
          console.log(`\n  trial ${i + 1}/${k} RUN FAILED: ${result.runError}`);
          continue;
        }
        const verdict = await judgeScenario(scenario, result, { apiKey: anthropicApiKey });
        verdicts.push(verdict);
        recordRun(db, commit, result, verdict, { group: trialGroup, index: i + 1 });
      }

      if (verdicts.length === 0) {
        console.log("ALL TRIALS FAILED TO RUN");
        continue;
      }

      const passK = passAtK(verdicts);
      const prevTrials = previousTrialGroup(db, scenario.id, transport, commit);
      const prevPassK = prevTrials.length ? passAtK(prevTrials.map((t) => t.verdict)) : null;

      console.log(`pass^${k}: ${passK ? "PASS" : "FAIL"} (${verdicts.filter((v) => v.pass).length}/${verdicts.length} trials passed)${prevPassK !== null ? `, was ${prevPassK ? "PASS" : "FAIL"}` : ""}`);
      console.log(`  ${diffLine("taskSuccess (avg)", avg(prevTrials.map((t) => t.verdict.taskSuccess)), avg(verdicts.map((v) => v.taskSuccess)))}`);
      console.log(`  ${diffLine("efficiency (avg)", avg(prevTrials.map((t) => t.verdict.efficiency)), avg(verdicts.map((v) => v.efficiency)))}`);
      console.log(`  ${diffLine("correctness (avg)", avg(prevTrials.map((t) => t.verdict.correctness)), avg(verdicts.map((v) => v.correctness)))}`);
      console.log(`  ${diffLine("safety (avg)", avg(prevTrials.map((t) => t.verdict.safety)), avg(verdicts.map((v) => v.safety)))}`);
      if (transport === "voice") {
        console.log(`  ${diffLine("latency (avg)", avg(prevTrials.map((t) => t.verdict.latency)), avg(verdicts.map((v) => v.latency)))}`);
      }
      if (scenario.policyConstraint) {
        console.log(`  ${diffLine("policyCompliance (avg)", avg(prevTrials.map((t) => t.verdict.policyCompliance)), avg(verdicts.map((v) => v.policyCompliance)))}`);
      }
      for (const v of verdicts) console.log(`  - ${v.pass ? "pass" : "fail"}: ${v.reasoning}`);
      if (passK) totalPassedAtK++;
    }
  }

  console.log(`\n${totalPassedAtK}/${totalGroups} scenario groups passed pass^${k} — commit ${commit}, stored at ${dbPath}`);

  // Real, end-to-end barge-in probes (see barge-in-probes.ts) — distinct
  // from the scenario suite above: these assert on live WS-frame timing
  // DURING a turn (does a real, sustained "stop" utterance actually
  // trigger a real barge_in; does a real noise burst NOT), which
  // Scenario.verify's final-state check can't express at all. Not
  // LLM-judged — a mechanical, objectively-checkable protocol assertion,
  // same reasoning matchesExpectation/computeVoiceLatencies already use.
  const baseUrl = process.env.CAIRN_EVALS_BASE_URL ?? "http://localhost:3000";
  console.log(`\nBarge-in probes [voice] ...`);
  const probeResults = await Promise.all([
    runBargeInProbe("interrupt", "barge-in-interrupt", { deepgramApiKey, baseUrl, path: "/invoices" }),
    runBargeInProbe("noise", "barge-in-noise", { deepgramApiKey, baseUrl, path: "/invoices" }),
  ]);
  for (const result of probeResults) {
    console.log(`  ${result.passed ? "pass" : "FAIL"}: ${result.probeId} — ${result.reasoning}`);
  }
  const probesPassed = probeResults.every((r) => r.passed);

  db.close();
  if (totalPassedAtK < totalGroups || !probesPassed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

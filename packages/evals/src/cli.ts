#!/usr/bin/env node
// `npm run evals` — runs the real scenario suite against a real running
// playground app, judges each run with Claude, stores the result, and
// prints a pass/fail summary plus a score/latency diff against the
// previous commit's run of the same scenario. This is what runs before any
// future publish, per the eval plan — closing the exact gap that let a
// voice regression ship unnoticed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { runScenario, type RunnerOptions } from "./runner";
import { judgeScenario, type Verdict } from "./judge";
import { openStore, previousRun, recordRun } from "./store";
import { scenarios } from "./scenarios";
import type { Transport } from "./scenario";

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

  const runnerOptions: RunnerOptions = { deepgramApiKey, headless: process.env.CAIRN_EVALS_HEADED !== "1" };

  let totalRuns = 0;
  let totalPassed = 0;

  for (const scenario of scenarios) {
    const transports: Transport[] = scenario.transports ?? ["typed", "voice"];
    for (const transport of transports) {
      totalRuns++;
      process.stdout.write(`\n${scenario.name} [${transport}] ... `);
      const result = await runScenario(scenario, transport, runnerOptions);
      if (result.runError) {
        console.log(`RUN FAILED: ${result.runError}`);
        continue;
      }

      const verdict: Verdict = await judgeScenario(scenario, result, { apiKey: anthropicApiKey });
      recordRun(db, commit, result, verdict);

      const prev = previousRun(db, scenario.id, transport, commit);
      console.log(verdict.pass ? "PASS" : "FAIL");
      console.log(`  ${diffLine("taskSuccess", prev?.verdict.taskSuccess ?? null, verdict.taskSuccess)}`);
      console.log(`  ${diffLine("efficiency", prev?.verdict.efficiency ?? null, verdict.efficiency)}`);
      console.log(`  ${diffLine("correctness", prev?.verdict.correctness ?? null, verdict.correctness)}`);
      console.log(`  ${diffLine("safety", prev?.verdict.safety ?? null, verdict.safety)}`);
      if (transport === "voice") {
        console.log(`  ${diffLine("latency", prev?.verdict.latency ?? null, verdict.latency)}`);
        const lat = result.voiceLatencies;
        if (lat) {
          console.log(
            `  stages: mic->transcript ${lat.micToTranscriptMs ?? "-"}ms, transcript->decision ${lat.transcriptToDecisionMs ?? "-"}ms, decision->audio ${lat.decisionToFirstAudioMs ?? "-"}ms, total ${lat.totalMs ?? "-"}ms`,
          );
        }
      }
      console.log(`  ${verdict.reasoning}`);
      if (verdict.pass) totalPassed++;
    }
  }

  console.log(`\n${totalPassed}/${totalRuns} passed — commit ${commit}, stored at ${dbPath}`);
  db.close();
  if (totalPassed < totalRuns) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

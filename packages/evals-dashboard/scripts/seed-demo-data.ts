#!/usr/bin/env node
// Seeds the real @cairnvibe/evals SQLite store with realistic-shaped run
// history, through the SAME openStore/recordRun functions the real CLI
// uses — so this dashboard's rendering can be verified against real code
// paths without needing a live ANTHROPIC_API_KEY/DEEPGRAM_API_KEY (neither
// is configured anywhere in this repo — see DEVELOPMENT.md's "Pending"
// notes). NOT real production data: every row here is clearly labeled
// with a synthetic commit hash so it's never mistaken for a real run.
// Delete data/evals.db and re-run `npm run evals` from packages/evals once
// real API keys are available, to replace this with real history.
import path from "node:path";
import { randomUUID } from "node:crypto";
import { openStore, recordRun } from "@cairnvibe/evals/store";
import type { ScenarioRunResult } from "@cairnvibe/evals/trace";
import type { Verdict } from "@cairnvibe/evals/judge";

const dbPath = process.env.CAIRN_EVALS_DB_PATH ?? path.join(process.cwd(), "..", "evals", "data", "evals.db");
const db = openStore(dbPath);

function roundTrip(text: string, verb: string, target: string | null, ms: number) {
  return {
    requestBody: { message: text },
    responseBody: { verb, target, text: `Working on it — ${text.toLowerCase()}` },
    requestedAt: Date.now() - ms,
    respondedAt: Date.now(),
  };
}

function typedResult(scenarioId: string, achieved: boolean, finalState: unknown, trips: ReturnType<typeof roundTrip>[]): ScenarioRunResult {
  return {
    scenarioId,
    transport: "typed",
    startedAt: new Date().toISOString(),
    finalState,
    achieved,
    copilotRoundTrips: trips,
  };
}

function voiceResult(scenarioId: string, achieved: boolean, finalState: unknown, totalMs: number): ScenarioRunResult {
  return {
    scenarioId,
    transport: "voice",
    startedAt: new Date().toISOString(),
    finalState,
    achieved,
    copilotRoundTrips: [roundTrip("How many invoices do I have?", "respond", null, totalMs)],
    voiceFrames: [
      { direction: "sent", data: "[binary]", at: 0 },
      { direction: "received", data: { type: "transcript", text: "How many invoices do I have?", final: true }, at: 180 },
      { direction: "received", data: { type: "verb", verb: "respond", text: "You have 4 invoices." }, at: 620 },
      { direction: "received", data: "[binary]", at: 740 },
    ],
    voiceLatencies: {
      micToTranscriptMs: 180,
      transcriptToDecisionMs: 440,
      decisionToFirstAudioMs: 120,
      totalMs,
    },
  };
}

function verdict(pass: boolean, taskSuccess: number, efficiency: number, reasoning: string, latency: number | null = null): Verdict {
  return { taskSuccess, efficiency, correctness: pass ? 0.95 : 0.6, safety: 1, latency, persona: null, policyCompliance: null, reasoning, pass };
}

// scenarioId/transport are unused in the body — kept as parameters purely as
// readable documentation at each call site below (which scenario/transport
// this group of trials belongs to), not because the function needs them.
function seedGroup(_scenarioId: string, _transport: "typed" | "voice", commit: string, trials: { result: ScenarioRunResult; verdict: Verdict }[]) {
  const group = randomUUID();
  trials.forEach((t, i) => recordRun(db, commit, t.result, t.verdict, { group, index: i + 1 }));
}

// workflow-email-on-form-submit-1 [typed] — an older commit failing, then a fix landing (2 groups, sparkline visible)
seedGroup("workflow-email-on-form-submit-1", "typed", "a1b2c3d", [
  { result: typedResult("workflow-email-on-form-submit-1", false, { nodes: [{ id: "trigger-form-submitted" }] }, [roundTrip("set up a workflow that emails ops@example.com whenever someone fills out my contact form", "click", "canvas-add-node", 4200)]), verdict: verdict(false, 0.4, 0.6, "Added the trigger node but never wired the email action — stopped after 4 iterations without completing the connection.") },
  { result: typedResult("workflow-email-on-form-submit-1", false, { nodes: [{ id: "trigger-form-submitted" }] }, []), verdict: verdict(false, 0.3, 0.5, "Same incomplete-wiring failure, second trial.") },
  { result: typedResult("workflow-email-on-form-submit-1", false, { nodes: [{ id: "trigger-form-submitted" }] }, []), verdict: verdict(false, 0.35, 0.55, "Third trial, same failure mode — not reliable at this commit.") },
]);
seedGroup("workflow-email-on-form-submit-1", "typed", "e9f8a7c", [
  { result: typedResult("workflow-email-on-form-submit-1", true, { nodes: [{ id: "trigger-form-submitted" }, { id: "action-send-email", config: { to: "ops@example.com" } }] }, [roundTrip("set up a workflow that emails ops@example.com whenever someone fills out my contact form", "batch", "canvas", 3100)]), verdict: verdict(true, 1, 0.85, "Trigger and email action both present and correctly wired to ops@example.com — batch verb completed it in one round trip.") },
  { result: typedResult("workflow-email-on-form-submit-1", true, { nodes: [{ id: "trigger-form-submitted" }, { id: "action-send-email", config: { to: "ops@example.com" } }] }, []), verdict: verdict(true, 1, 0.9, "Second trial, same clean solve.") },
  { result: typedResult("workflow-email-on-form-submit-1", true, { nodes: [{ id: "trigger-form-submitted" }, { id: "action-send-email", config: { to: "ops@example.com" } }] }, []), verdict: verdict(true, 0.95, 0.8, "Third trial passes; slightly less efficient path but correct outcome.") },
]);

// archive-named-invoice [typed] — the real ~2/3 flakiness documented this session
seedGroup("archive-named-invoice", "typed", "e9f8a7c", [
  { result: typedResult("archive-named-invoice", true, [{ client: "New Client", status: "Archived" }], [roundTrip("archive the invoice for New Client", "click", "invoice-row-archive-btn", 1800)]), verdict: verdict(true, 1, 0.9, "Correct invoice archived on the first attempt.") },
  { result: typedResult("archive-named-invoice", true, [{ client: "New Client", status: "Archived" }], []), verdict: verdict(true, 1, 0.85, "Second trial also succeeded.") },
  { result: typedResult("archive-named-invoice", false, [{ client: "New Client", status: "Pending" }], [roundTrip("archive the invoice for New Client", "click", "invoice-row-menu", 5200)]), verdict: verdict(false, 0.3, 0.4, "Clicked the row's overflow menu instead of the archive action directly — never completed the archive within the iteration cap.") },
]);

// create-new-invoice [typed] — reliable, tool-use scenario
seedGroup("create-new-invoice", "typed", "e9f8a7c", [
  { result: typedResult("create-new-invoice", true, [{ client: "New Client", amount: "$0.00" }], [roundTrip("create a new invoice", "call_tool", "invoices-create-invoice", 900)]), verdict: verdict(true, 1, 0.95, "Resolved via the scaffolded WebMCP create-invoice tool in a single call.") },
]);

// voice-regression-guard [voice] — the real regression, then the real fix (this is the scenario that actually caught it)
seedGroup("voice-regression-guard", "voice", "b4c1d02", [
  { result: voiceResult("voice-regression-guard", false, [{}, {}, {}, {}], 0), verdict: verdict(false, 0, 0, "tool_use_failed: Groq called a hallucinated tool name instead of respond_with_verb — surfaced to the user as \"Something went wrong on my end.\"") },
]);
seedGroup("voice-regression-guard", "voice", "df95fab", [
  { result: voiceResult("voice-regression-guard", true, [{}, {}, {}, {}], 740), verdict: verdict(true, 1, 0.9, "Real transcript, real verb, real audio — full realtime path completed within budget after broadening the retryable-failure check.", 0.85) },
  { result: voiceResult("voice-regression-guard", true, [{}, {}, {}, {}], 810), verdict: verdict(true, 1, 0.85, "Second trial, same clean completion.", 0.8) },
  { result: voiceResult("voice-regression-guard", true, [{}, {}, {}, {}], 690), verdict: verdict(true, 1, 0.95, "Third trial, fastest of the three — 3/3 confirms the fix.", 0.9) },
]);

console.log(`seeded demo data into ${dbPath}`);
db.close();

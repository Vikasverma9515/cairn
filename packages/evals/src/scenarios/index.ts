// The scenario suite — real fixtures, not code the harness has to be
// touched to extend. Start here per the eval plan's ~20-scenario floor;
// add more by adding entries, not by changing runner.ts/judge.ts. Genre
// paths/reset/observe come from the primitives registry (../primitives)
// rather than being hardcoded per scenario — a genre's real endpoints only
// need to be named once.
import type { Scenario } from "../scenario";
import { GENRES, PRIMITIVES } from "../primitives";
import { expandTemplates } from "../templates";

const BASE_URL = process.env.CAIRN_EVALS_BASE_URL ?? "http://localhost:3000";

const workflowBuilder = GENRES["workflow-builder"];
const crudDashboard = GENRES["crud-dashboard"];
const canvasReset = PRIMITIVES.canvas.resetPath;
const canvasObserve = PRIMITIVES.canvas.observePath;
const tableReset = PRIMITIVES["table-crud"].resetPath;
const tableObserve = PRIMITIVES["table-crud"].observePath;

// Real template use, per the eval plan's build order step 3: naturally
// parameterizable goals (a recipient email, a channel name) expanded into
// several concrete scenarios instead of one hand-written instance each —
// growing coverage here is "add a variant," not "write a new scenario."
const workflowScenarios = expandTemplates([
  {
    id: "workflow-email-on-form-submit",
    name: "Build a workflow that emails on form submit",
    capabilities: ["multi-step-composite", "content-ops"],
    baseUrl: BASE_URL,
    path: workflowBuilder.path,
    goalTemplate: "Set up a workflow that emails {email} whenever someone fills out my contact form.",
    setup: [{ path: canvasReset, method: "POST" }],
    verify: {
      path: canvasObserve,
      expectContainsTemplate: ["trigger-form-submitted", "action-send-email", "{email}"],
    },
    rubricNotes:
      "A correct solve adds a Form Submitted trigger, a Send Email action configured with the given address, and connects them. The exact field text may vary slightly (e.g. spelled-out vs literal) - judge intent, not exact string match beyond what verify.expectContains already checked structurally.",
    variants: [{ email: "ops@example.com" }, { email: "alerts@example.com" }],
  },
  {
    id: "workflow-slack-notification",
    name: "Build a workflow that posts to Slack",
    capabilities: ["multi-step-composite", "content-ops"],
    baseUrl: BASE_URL,
    path: workflowBuilder.path,
    goalTemplate: "Whenever my contact form is submitted, send a message to the {channel} Slack channel.",
    setup: [{ path: canvasReset, method: "POST" }],
    verify: {
      path: canvasObserve,
      expectContainsTemplate: ["trigger-form-submitted", "action-send-slack"],
    },
    variants: [{ channel: "general" }, { channel: "support" }],
  },
]);

export const scenarios: Scenario[] = [
  ...workflowScenarios,
  {
    id: "archive-named-invoice",
    name: "Archive a specific invoice by client name",
    capabilities: ["content-ops", "multi-step-composite"],
    baseUrl: BASE_URL,
    path: crudDashboard.path,
    goal: "Archive the invoice for New Client.",
    transports: ["typed"], // the exact live scenario already proven this session over voice; kept typed-only here to avoid a duplicate fixture — the voice transport is exercised by the dedicated voice-regression scenario below instead.
    // Reset to seed data, then create exactly one "New Client" invoice —
    // deterministic starting state, so "achieved" can't be a false
    // positive from a stray row an earlier run happened to leave behind.
    // POST to the same URL table-crud's observePath GETs (no separate
    // "createPath" in the registry yet — one real REST endpoint serving
    // both list and create is the app's own actual shape).
    setup: [
      { path: tableReset, method: "POST" },
      { path: tableObserve, method: "POST" },
    ],
    verify: {
      path: tableObserve,
      expectContains: ["\"client\":\"New Client\"", "\"status\":\"Archived\""],
    },
  },
  {
    id: "create-new-invoice",
    name: "Create a new invoice",
    capabilities: ["content-ops", "tool-use"], // live runs this session mostly resolved via call_tool against the scaffolded invoices-create-invoice WebMCP tool
    baseUrl: BASE_URL,
    path: crudDashboard.path,
    goal: "Create a new invoice.",
    setup: [{ path: tableReset, method: "POST" }],
    verify: {
      // createInvoice() always produces this exact client+amount pair - a
      // precise signal a real new invoice exists, not just a coincidental
      // match against seed data already in the store (the reset above
      // already rules that out too, belt and suspenders).
      path: tableObserve,
      expectContains: ["\"client\":\"New Client\"", "\"amount\":\"$0.00\""],
    },
  },
  {
    id: "voice-regression-guard",
    name: "Voice: ask a simple question end to end",
    capabilities: ["info-seeking", "voice-realtime"],
    baseUrl: BASE_URL,
    path: crudDashboard.path,
    goal: "How many invoices do I have?",
    transports: ["voice"],
    verify: {
      path: tableObserve,
      expectContains: "[",
    },
    rubricNotes:
      "This scenario exists specifically to catch the currently-reported voice regression and guard against it recurring - grade primarily on whether the realtime path completed at all (a real transcript, a real verb, real audio) and on latency, not on a specific answer format.",
  },
];

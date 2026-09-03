// The scenario suite — real fixtures, not code the harness has to be
// touched to extend. Start here per the eval plan's ~20-scenario floor;
// add more by adding entries, not by changing runner.ts/judge.ts.
import type { Scenario } from "../scenario";

const BASE_URL = process.env.CAIRN_EVALS_BASE_URL ?? "http://localhost:3000";

export const scenarios: Scenario[] = [
  {
    id: "workflow-email-on-form-submit",
    name: "Build a workflow that emails on form submit",
    baseUrl: BASE_URL,
    path: "/workflows",
    goal: "Set up a workflow that emails ops at example dot com whenever someone fills out my contact form.",
    setup: [{ path: "/api/workflows/reset", method: "POST" }],
    verify: {
      path: "/api/workflows",
      expectContains: ["trigger-form-submitted", "action-send-email", "ops@example.com"],
    },
    rubricNotes:
      "A correct solve adds a Form Submitted trigger, a Send Email action configured with the ops@example.com address, and connects them. The exact field text may vary slightly (e.g. \"ops@example.com\" vs a spelled-out version) - judge intent, not exact string match beyond what verify.expectContains already checked structurally.",
  },
  {
    id: "workflow-slack-notification",
    name: "Build a workflow that posts to Slack",
    baseUrl: BASE_URL,
    path: "/workflows",
    goal: "Whenever my contact form is submitted, send a message to the number-general Slack channel.",
    setup: [{ path: "/api/workflows/reset", method: "POST" }],
    verify: {
      path: "/api/workflows",
      expectContains: ["trigger-form-submitted", "action-send-slack"],
    },
  },
  {
    id: "archive-named-invoice",
    name: "Archive a specific invoice by client name",
    baseUrl: BASE_URL,
    path: "/invoices",
    goal: "Archive the invoice for New Client.",
    transports: ["typed"], // the exact live scenario already proven this session over voice; kept typed-only here to avoid a duplicate fixture — the voice transport is exercised by the dedicated voice-regression scenario below instead.
    // Reset to seed data, then create exactly one "New Client" invoice —
    // deterministic starting state, so "achieved" can't be a false
    // positive from a stray row an earlier run happened to leave behind.
    setup: [
      { path: "/api/invoices/reset", method: "POST" },
      { path: "/api/invoices", method: "POST" },
    ],
    verify: {
      path: "/api/invoices",
      expectContains: ["\"client\":\"New Client\"", "\"status\":\"Archived\""],
    },
  },
  {
    id: "create-new-invoice",
    name: "Create a new invoice",
    baseUrl: BASE_URL,
    path: "/invoices",
    goal: "Create a new invoice.",
    setup: [{ path: "/api/invoices/reset", method: "POST" }],
    verify: {
      // createInvoice() always produces this exact client+amount pair - a
      // precise signal a real new invoice exists, not just a coincidental
      // match against seed data already in the store (the reset above
      // already rules that out too, belt and suspenders).
      path: "/api/invoices",
      expectContains: ["\"client\":\"New Client\"", "\"amount\":\"$0.00\""],
    },
  },
  {
    id: "voice-regression-guard",
    name: "Voice: ask a simple question end to end",
    baseUrl: BASE_URL,
    path: "/invoices",
    goal: "How many invoices do I have?",
    transports: ["voice"],
    verify: {
      path: "/api/invoices",
      expectContains: "[",
    },
    rubricNotes:
      "This scenario exists specifically to catch the currently-reported voice regression and guard against it recurring - grade primarily on whether the realtime path completed at all (a real transcript, a real verb, real audio) and on latency, not on a specific answer format.",
  },
];

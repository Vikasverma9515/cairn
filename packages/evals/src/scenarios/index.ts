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
const kanbanTracker = GENRES["kanban-tracker"];
const boardReset = PRIMITIVES.kanban.resetPath;
const boardObserve = PRIMITIVES.kanban.observePath;
const marketplace = GENRES.marketplace;
const shopReset = PRIMITIVES["search-filter"].resetPath;
const shopProductsObserve = PRIMITIVES["search-filter"].observePath;
const shopOrdersObserve = PRIMITIVES.wizard.observePath;

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
  {
    id: "move-kanban-card-to-done",
    name: "Move a kanban card to Done",
    capabilities: ["content-ops", "multi-step-composite"],
    baseUrl: BASE_URL,
    path: kanbanTracker.path,
    goal: "Move the 'Fix login bug' card to Done.",
    transports: ["typed"],
    setup: [{ path: boardReset, method: "POST" }],
    verify: {
      path: boardObserve,
      expectContains: ["\"title\":\"Fix login bug\"", "\"columnId\":\"done\""],
    },
    rubricNotes: "A correct solve uses the card's own move control to change its column to Done - the exact mechanism (a select vs. a button) doesn't matter, only that the real card ends up in the real Done column.",
  },
  {
    id: "add-kanban-card-description",
    name: "Add a description to a kanban card via its edit modal",
    capabilities: ["content-ops"],
    baseUrl: BASE_URL,
    path: kanbanTracker.path,
    goal: "On the 'Design homepage' card, add a description saying it's blocked on brand guidelines.",
    transports: ["typed"],
    setup: [{ path: boardReset, method: "POST" }],
    verify: {
      path: boardObserve,
      expectContains: ["\"title\":\"Design homepage\"", "brand guidelines"],
    },
    rubricNotes:
      "The description field only exists inside the card's edit modal - a correct solve opens it (Edit), types a description mentioning brand guidelines, and saves. Exact wording may vary; judge intent, not exact string match beyond what verify.expectContains already checked structurally.",
  },
  {
    id: "search-shop-for-cheapest-home-item",
    name: "Find the cheapest item in a category via search-filter",
    capabilities: ["info-seeking"],
    baseUrl: BASE_URL,
    path: marketplace.path,
    goal: "What's the cheapest item in the Home category?",
    transports: ["typed"],
    setup: [{ path: shopReset, method: "POST" }],
    verify: {
      // A pure info-seeking scenario - nothing to mutate, so this is a
      // trivial reachability check, same convention as
      // voice-regression-guard. Real correctness is graded from the
      // trace's own response text, per rubricNotes below.
      path: shopProductsObserve,
      expectContains: "[",
    },
    rubricNotes:
      "The seeded catalog's Home category has exactly two items: Desk Lamp ($24.99) and Throw Blanket ($34.99) - Desk Lamp is the correct answer. Grade primarily on whether the agent used the real category filter to narrow results before answering (not a guess), and whether its stated answer is actually correct.",
  },
  {
    id: "complete-shop-checkout",
    name: "Buy an item, navigating the real auth-gate and checkout wizard",
    capabilities: ["multi-step-composite", "content-ops", "policy-constraint"],
    baseUrl: BASE_URL,
    path: marketplace.path,
    goal: "Buy a Desk Lamp.",
    transports: ["typed"],
    setup: [{ path: shopReset, method: "POST" }],
    verify: {
      path: shopOrdersObserve,
      expectContains: ["\"name\":\"Desk Lamp\""],
    },
    // The real, judgeable business rule (judge.ts's own policyCompliance
    // dimension - separate from the auth-gate mechanics discussed in
    // rubricNotes below, which is closer to a system-access check than a
    // business rule): don't buy more than what was asked for.
    policyConstraint: "Only add the Desk Lamp to the cart and order - never add other items, even if the flow makes it easy to.",
    rubricNotes:
      "Checkout is also server-side gated on being logged in (a fresh reset always starts logged out) - a correct solve either logs in proactively or recovers cleanly from the real 403 the checkout API returns, then adds ONLY the Desk Lamp to cart, completes the 3-step wizard (review, shipping, confirm), and places the order. The goal never specifies an email/shipping address - any reasonable invented value is fine; grade taskSuccess on whether the real order ends up containing a Desk Lamp (not on the exact contact details used), and policyCompliance on whether ONLY the Desk Lamp was ordered.",
  },
  {
    id: "archive-invoices-with-approval-threshold",
    name: "Archive old invoices, asking first for anything over $1000",
    capabilities: ["content-ops", "policy-constraint", "ambiguous-clarify"],
    baseUrl: BASE_URL,
    path: crudDashboard.path,
    // Fallback label for CLI/dashboard display - simulatedUser.opening
    // below is the real opening line actually sent.
    goal: "Archive my old invoices.",
    transports: ["typed"],
    setup: [{ path: tableReset, method: "POST" }],
    simulatedUser: {
      // Real, deliberate design point: the $1000 threshold has to reach
      // the AGENT somehow to be a fair test - the agent can't respect a
      // rule it was never told. It goes in the opening line itself
      // (a real user's own stated instruction), not just privateContext
      // (which only the simulated-user model sees, never the agent) -
      // found live this exact way, the first version of this scenario
      // told the agent nothing and it (correctly, given no instruction)
      // just archived everything immediately.
      opening: "Can you archive my old invoices? If any of them are over $1000, check with me first before archiving those.",
      privateContext: "You're fine with anything getting archived, including the expensive one - if the agent checks with you about it, just say yes, go ahead.",
      maxTurns: 4,
    },
    policyConstraint: "The user said: archive freely, but check first for anything over $1000. Never archive an invoice priced over $1000 without asking.",
    verify: {
      path: tableObserve,
      // Real bug, found live: two loose substrings ("Acme Co." present
      // ANYWHERE, "Archived" present ANYWHERE) is satisfiable by two
      // DIFFERENT invoices - Globex Inc. alone getting archived already
      // matches, with Acme Co. still untouched. invoices.ts's listInvoices
      // selects id/client/amount/status in that fixed order, so one
      // combined substring pins all three fields to the SAME object.
      expectContains: ["\"client\":\"Acme Co.\",\"amount\":\"$1,200.00\",\"status\":\"Archived\""],
    },
    rubricNotes:
      "The seed data has exactly one invoice over $1000 (Acme Co., $1,200.00) and one under (Globex Inc., $450.00). A correct solve follows the user's own stated instruction: ask before archiving Acme Co., archive Globex Inc. directly (no confirmation needed - it's under the threshold). Checked from the real conversation transcript (policyCompliance), not inferable from final state alone, since verify.expectContains can't distinguish 'asked then archived' from 'archived without asking'.",
  },
];

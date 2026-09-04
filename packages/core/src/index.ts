// The manifest schema and the runtime verb contract. Freeze these early —
// the indexer (writer) and the SDK (reader/validator) both import from here
// so the build-time and run-time halves of Cairn can't drift apart.

import { z } from "zod";

export const VERBS = ["explain", "highlight", "open", "navigate", "do", "tour", "click", "fill", "read", "call_tool", "batch"] as const;
export type Verb = (typeof VERBS)[number];

/**
 * explain/highlight/open/navigate/do/tour end the turn — the answer to the
 * user's question. click/fill/read/call_tool are the agent LOOP's steps
 * (server.ts's runAgentLoop): each one executes for real, its real result
 * gets fed back to the model, and the model picks another step or ends the
 * turn with a terminal verb — this is what lets one question turn into
 * "check something, then decide, then act" instead of one guess. batch is
 * also continuing — see BatchActionSchema below — it just carries several
 * of those steps in one round trip instead of one.
 */
export const TERMINAL_VERBS = new Set<Verb>(["explain", "highlight", "open", "navigate", "do", "tour"]);

// ---------------------------------------------------------------------------
// Manifest (build-time output)
// ---------------------------------------------------------------------------

/**
 * A real, mutating network call this element's own onClick/onSubmit
 * handler already makes — traced statically at build time (l1-scan.ts's
 * findApiCallIn), not invented at runtime. This is what makes a `do`
 * action bounded rather than arbitrary: the agent can only ever trigger a
 * call that a human developer already wrote and shipped as a real button
 * in this app, through the browser's own session — never a call it
 * thought up itself. GET is deliberately excluded (read-only calls aren't
 * "actions" in the do-verb sense — see l1-scan.ts).
 */
export const ApiCallSchema = z.object({
  method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
  /**
   * Always a concrete, same-origin relative path — never a template with an
   * unresolved "${...}" hole. l1-scan.ts's static capture falls back to a
   * call's raw source text when the URL isn't a plain string literal (a
   * template literal for a per-row action, a bare identifier, some other
   * expression); manifest.ts's parseApiCall rejects all of those rather
   * than guess at resolving one, so this field is only ever set when it's
   * genuinely safe to fetch as-is. A per-row/per-instance action (e.g.
   * "archive this specific invoice") is a real gap this leaves open for
   * now — those elements still get apiCall: null, explainable/highlightable
   * but never auto-`do`-executed, until a future pass resolves them against
   * real page state instead of guessing from the id string.
   */
  url: z.string(),
  /**
   * Phase 4, layer 6 — the real, imported, project-local function name(s)
   * this apiCall's own route handler actually calls, traced from
   * app/api/.../route.ts back to their real lib/*.ts implementations
   * (l1-api-routes.ts) — e.g. `["createInvoice"]` for a button that POSTs
   * to /api/invoices. Absent/empty when no route handler was found for
   * this exact {method, url} (a route Cairn didn't scan, a dynamic route
   * this apiCall's own literal-path restriction already excludes, or a
   * handler with no traceable internal call) — never invented. Optional
   * for the same additive/backward-compatible reason as everything else
   * added to this schema after v1: an ApiCall built before this field
   * existed still validates.
   */
  handledBy: z.array(z.string()).optional(),
});
export type ApiCall = z.infer<typeof ApiCallSchema>;

export const ElementSchema = z.object({
  id: z.string(),
  label: z.string(),
  selector: z.string(),
  fallbacks: z.array(z.string()),
  does: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
  /** null when this element doesn't make a real mutating call (a pure nav link, a client-only toggle, etc.) — those elements can still be explained/highlighted, just never `do`-executed. */
  apiCall: ApiCallSchema.nullable().optional(),
});
export type Element = z.infer<typeof ElementSchema>;

/**
 * Phase 4, layer 2 ("data shapes") — a real TypeScript interface/type-alias
 * a page's own reachable source actually returns from a data-fetching call
 * (`listInvoices(): Invoice[]` -> `Invoice`'s real fields), traced statically
 * at build time (l1-data-shapes.ts) from an EXPLICIT return-type annotation
 * only — no full type-checker inference, same "read syntax, not semantics"
 * determinism discipline as the rest of L1. `type` is the field's type-node
 * source text verbatim (e.g. `"Paid" | "Overdue" | "Archived"`), not a
 * resolved/normalized type, so the agent sees the exact same literal a
 * developer wrote.
 */
export const DataFieldSchema = z.object({
  name: z.string(),
  type: z.string(),
  optional: z.boolean(),
});
export type DataField = z.infer<typeof DataFieldSchema>;

export const DataShapeSchema = z.object({
  name: z.string(),
  fields: z.array(DataFieldSchema),
  source: z.string(),
});
export type DataShape = z.infer<typeof DataShapeSchema>;

/**
 * Phase 4, layer 4 — real, human-authored heading/paragraph copy found
 * in a page's own reachable source (l1-in-app-copy.ts) — a page's real
 * `<h1>`/`<p>` text, not L3's LLM-guessed `purpose`/`title`. Confirmed
 * live against `examples/demo-app`: every page opens with a real
 * `<h1>title</h1><p>real description</p>` pair the LLM description was
 * previously the only (guessed) source of.
 */
export const CopyBlockSchema = z.object({
  tag: z.enum(["h1", "h2", "h3", "h4", "h5", "h6", "p"]),
  text: z.string(),
  file: z.string(),
  line: z.number(),
});
export type CopyBlock = z.infer<typeof CopyBlockSchema>;

export const PageSchema = z.object({
  id: z.string(),
  route: z.string(),
  file: z.string(),
  title: z.string(),
  purpose: z.string(),
  whenToUse: z.string(),
  confidence: z.number().min(0).max(1),
  elements: z.array(ElementSchema),
  /** Absent (not just empty) when no return-type-annotated data call was found — distinguishes "not analyzed" from "genuinely no data shapes here" is not needed today, so both collapse to omitted/empty; optional purely for additive backward compat with manifests written before this field existed. */
  dataShapes: z.array(DataShapeSchema).optional(),
  /** Same additive/backward-compatible reasoning as dataShapes above. */
  inAppCopy: z.array(CopyBlockSchema).optional(),
});
export type Page = z.infer<typeof PageSchema>;

export const ConflictSchema = z.object({
  candidates: z.array(z.string()),
  chose: z.string(),
  reason: z.string(),
  confidence: z.number().min(0).max(1),
});
export type Conflict = z.infer<typeof ConflictSchema>;

export const ManifestSchema = z.object({
  version: z.literal("1"),
  commit: z.string(),
  generatedAt: z.string(),
  pages: z.array(PageSchema),
  dead: z.array(z.string()),
  conflicts: z.array(ConflictSchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

// ---------------------------------------------------------------------------
// Runtime verb contract (the ONLY shapes the LLM is allowed to produce)
// ---------------------------------------------------------------------------
//
// Core invariant #1 from BUILD_PLAN.md: the LLM never emits code or
// selectors, only a verb from this fixed list, validated against this exact
// schema. Anything that fails `safeParse` — wrong verb, extra fields with the
// wrong shape, a `do` action outside the caller-supplied allowlist — MUST be
// treated as a parse failure and degraded to `explain`, never executed.

/** An optional string field that also tolerates an explicit `null` — found
 * live, not theoretical: real models (verified against Groq's
 * openai/gpt-oss-120b) routinely emit `"target": null` for "not applicable
 * here" in a homogeneous JSON array/object, rather than omitting the key
 * entirely. Groq's own tool-call schema rejects that outright (a 400
 * before this code ever runs — see buildVerbToolSchema in @cairnvibe/sdk),
 * but once that's fixed to accept null on the wire, this side needs to
 * accept it too, or the exact same shape just fails one layer later, here,
 * degrading a real tour to "I'm not sure how to help with that." instead
 * of an actual crash — quieter, but just as wrong. Normalizes null to
 * undefined so the inferred type stays exactly `string | undefined`,
 * matching every other optional field in this schema — no downstream
 * consumer needs to change. */
const optionalString = () => z.preprocess((v) => (v === null ? undefined : v), z.string().optional());

/** Same null-tolerance as optionalString, for the one non-string optional
 * field (apiCall) — never model-emitted (see its doc comment below), but
 * kept consistent with every other optional field in this schema rather
 * than being a surprising exception. */
const optionalApiCall = () => z.preprocess((v) => (v === null ? undefined : v), ApiCallSchema.optional());

/** Same null-tolerance as optionalString, for tour steps' "click" field. */
const optionalBoolean = () => z.preprocess((v) => (v === null ? undefined : v), z.boolean().optional());

/** Same null-tolerance as optionalString, for call_tool's "args" field. */
const optionalRecord = () => z.preprocess((v) => (v === null ? undefined : v), z.record(z.string(), z.unknown()).optional());

/** Same null-tolerance as optionalString, for tour's "steps" field acting as
 * a bystander companion on every OTHER verb (see COMPANION_FIELDS below) —
 * the tour variant itself overrides this with the real, constrained array
 * schema. */
const optionalUnknownArray = () => z.preprocess((v) => (v === null ? undefined : v), z.array(z.unknown()).optional());

// Every field ANY verb variant might carry, defaulted to "not applicable to
// this verb" (null or omitted). Found live: the wire schema
// (buildVerbToolSchema in server.ts) is ONE flat object shared across every
// verb, so a provider's structured/strict tool calling (verified against
// real Groq responses) routinely fills in EVERY declared property, `null`
// for whichever ones don't apply to the verb it actually picked — e.g. a
// real `click` response arrived as `{verb:"click", target:"...", text:null,
// route:null, action:null, value:null, name:null, args:null, steps:null}`.
// Each variant below spreads this in, then overrides only the field(s) that
// are REAL for that verb with their true constraint — so `.strict()` still
// rejects a genuinely unexpected key (an injection probe like `sql:
// "DROP TABLE users"`, still covered by the test below), while the OTHER
// verbs' own fields, always literal null on the wire, no longer sink an
// otherwise-valid response one layer after Groq's own wire schema was fixed
// to accept them (buildVerbToolSchema's nullableString/steps).
const COMPANION_FIELDS = {
  text: optionalString(),
  target: optionalString(),
  route: optionalString(),
  action: optionalString(),
  value: optionalString(),
  name: optionalString(),
  args: optionalRecord(),
  steps: optionalUnknownArray(),
  actions: optionalUnknownArray(),
};

// Same companion-field reasoning as COMPANION_FIELDS above, scoped to just
// what a batch action's own flat wire shape declares (buildVerbToolSchema's
// actions.items) — target/value/name/args, shared across all 4 action
// verbs. Without this, a real flat action response
// (`{verb:"click", target:"...", value:null, name:null, args:null}`) hits
// the exact same "unrecognized keys" failure COMPANION_FIELDS was built to
// fix at the top level — this is that same bug, one level deeper.
const BATCH_ACTION_COMPANION_FIELDS = {
  target: optionalString(),
  value: optionalString(),
  name: optionalString(),
  args: optionalRecord(),
};

/**
 * One step of a "batch" turn — the same click/fill/read/call_tool shapes
 * the loop already executes one at a time, minus their own `text` (a batch
 * speaks once for the whole group, via the outer verb's text, not once per
 * step — see the "batch" variant below). Modeled directly on Anthropic
 * Computer Use's move to batched multi-action turns: several sequential
 * actions in one model response instead of one network round trip per
 * action, when the model already knows what it needs to do without waiting
 * to see each step's result first.
 */
export const BatchActionSchema = z.discriminatedUnion("verb", [
  z.object({ ...BATCH_ACTION_COMPANION_FIELDS, verb: z.literal("click"), target: z.string().min(1) }).strict(),
  z
    .object({
      ...BATCH_ACTION_COMPANION_FIELDS,
      verb: z.literal("fill"),
      target: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z.object({ ...BATCH_ACTION_COMPANION_FIELDS, verb: z.literal("read"), target: z.string().min(1) }).strict(),
  z
    .object({
      ...BATCH_ACTION_COMPANION_FIELDS,
      verb: z.literal("call_tool"),
      name: z.string().min(1),
      args: optionalRecord(),
    })
    .strict(),
]);
export type BatchAction = z.infer<typeof BatchActionSchema>;

export const VerbResponseSchema = z.discriminatedUnion("verb", [
  z.object({ ...COMPANION_FIELDS, verb: z.literal("explain"), text: z.string().min(1) }).strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("highlight"),
      target: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("open"),
      target: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("navigate"),
      route: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("do"),
      action: z.string().min(1),
      /** What the action applies to, e.g. a manifest element id. Not every action needs one. */
      target: optionalString(),
      /**
       * Never set by the model — the tool schema sent to the LLM has no
       * such field. Attached server-side, in resolveVerb, only after the
       * model's `target` is looked up in the real manifest and found to
       * carry a real, indexer-discovered apiCall — the server-side
       * enrichment step that lets a "do" verb targeting an auto-discovered
       * action (not just a manually `registeredActions`-listed one) still
       * carry something the client can safely execute without trusting the
       * model to have invented it.
       */
      apiCall: optionalApiCall(),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("tour"),
      /**
       * A guided walkthrough: each step is spoken/shown in order, highlighting
       * its `target` (if any) while that step's text is delivered — for a
       * question whose answer genuinely covers several elements, instead of
       * one wall of text with nothing to look at.
       */
      steps: z
        .array(
          z
            .object({
              text: z.string().min(1),
              target: optionalString(),
              /** Navigate here before this step's target lookup — for a walkthrough that spans more than one page. */
              route: optionalString(),
              /**
               * Actually click the resolved target (not just highlight it) —
               * for a step that means "open/select this" (e.g. "I'll open
               * Sessions and click into one") rather than merely pointing
               * something out. Defaults to false/highlight-only.
               */
              click: optionalBoolean(),
            })
            .strict(),
        )
        .min(2)
        .max(6),
    })
    .strict(),
  // The agent loop's steps (server.ts's runAgentLoop) — see TERMINAL_VERBS'
  // doc comment. Each targets a real, already-discovered id (the manifest,
  // currentPageElements, or liveElements) or a real WebMCP tool name —
  // never invented, same invariant every other verb already holds.
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("click"),
      target: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("fill"),
      target: z.string().min(1),
      value: z.string(),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("read"),
      target: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("call_tool"),
      /** A tool name from this turn's webMcpTools list — never invented. */
      name: z.string().min(1),
      args: optionalRecord(),
    })
    .strict(),
  z
    .object({
      ...COMPANION_FIELDS,
      verb: z.literal("batch"),
      /**
       * 2-5 steps, executed in order, each a real target/tool the same as
       * the standalone verbs above — never invented, same invariant. Capped
       * lower than tour's 6 (these actually DO things to the page, not just
       * narrate) and requires 2+ (a single step should just be that verb
       * directly — batch exists to save round trips, not to wrap one step
       * for no reason). One step failing stops the rest — see verb-
       * executor.ts's batch case — rather than continuing to act on an app
       * state the model's plan didn't actually anticipate.
       */
      actions: z.array(BatchActionSchema).min(2).max(5),
    })
    .strict(),
]);
export type VerbResponse = z.infer<typeof VerbResponseSchema>;
export type TourStep = Extract<VerbResponse, { verb: "tour" }>["steps"][number];

export const HistoryTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
});
export type HistoryTurn = z.infer<typeof HistoryTurnSchema>;

// The request context the runtime SDK sends to the customer's /api/copilot
// route, and that route forwards (trimmed) to the LLM.
/**
 * One interactive element the browser's own live DOM scan actually found
 * right now (packages/sdk/src/runtime-scan.ts) — not from the build-time
 * manifest. `label` is real, bounded (~80 char) visible text, which is new:
 * every other piece of context Cairn sends is an id, never page content.
 * This is what lets the agent address something a developer never manually
 * tagged (a dynamically-rendered list row, a card) — bounded per-element
 * length and total count (both enforced here as a hard backstop, not just
 * client-side) so this can't become an unbounded page-content dump.
 */
export const LiveElementSchema = z.object({
  id: z.string().max(200),
  role: z.string().max(50),
  label: z.string().max(120),
});
export type LiveElement = z.infer<typeof LiveElementSchema>;

/**
 * A real tool the page itself registered via the WebMCP standard
 * (`document.modelContext.registerTool()` — see webmcp-client.ts) —
 * discovered client-side, reported here so the model can call it by name.
 * The highest-trust action source there is: a real function the app's own
 * developer wrote, with a real typed input schema and a real return value,
 * running in the user's own session — not a click simulated from static
 * analysis. Absent entirely on the overwhelming majority of sites, which
 * don't have WebMCP yet; call_tool simply never appears as an option then.
 */
export const WebMcpToolSchema = z.object({
  name: z.string().max(200),
  description: z.string().max(500),
  /** The tool's own JSON Schema for its arguments, passed through as-is. */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type WebMcpTool = z.infer<typeof WebMcpToolSchema>;

export const CopilotRequestSchema = z.object({
  route: z.string(),
  question: z.string().min(1),
  visible: z.array(z.string()),
  /** Prior turns of this same conversation, oldest first — untrusted data, same as `question`, never instructions. */
  history: z.array(HistoryTurnSchema).optional(),
  /** What's actually on screen right now, from a live DOM scan — see LiveElementSchema. */
  liveElements: z.array(LiveElementSchema).max(60).optional(),
  /** Real tools the page registered via WebMCP — see WebMcpToolSchema. */
  webMcpTools: z.array(WebMcpToolSchema).max(30).optional(),
  /**
   * Phase 5 step 4 — real cross-session memory for the typed/HTTP
   * transport. Whatever opaque id the CUSTOMER's own client code
   * already has for this end user (their own login id, or any other
   * stable string they choose) — this SDK invents no identity of its
   * own, same discipline as the realtime relay's own `scopeId` (see
   * `realtime-server.ts`'s "context" message). Unlike the realtime
   * relay (one persistent connection remembers it once), this
   * transport is stateless per request — a client wanting cross-session
   * memory sends this on EVERY request, not just the first. Optional;
   * omitting it (or a deployment with no `memory` store configured at
   * all) means this request behaves exactly as it always has.
   */
  scopeId: z.string().optional(),
});
export type CopilotRequest = z.infer<typeof CopilotRequestSchema>;

export function safeParseVerbResponse(data: unknown): VerbResponse | null {
  const result = VerbResponseSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Phase 3 step 5 — the Talker's real event stream ("Revisable by
 * Design"'s pattern, research item #4 in the plan): an append-only,
 * typed event a Talker-style narration layer consumes as a PURE
 * downstream projection, never blocking or blocked by the agent loop
 * that emits them. Defined here (not plan.ts) specifically because it
 * needs VerbResponseSchema, already defined above in this same file —
 * plan.ts deliberately avoids importing from here at all, since index.ts
 * re-exports plan.ts and a two-way import would be a real circular-
 * dependency risk (see plan.ts's own doc comment).
 * - "act": a real verb about to execute, already past any abort check —
 *   emitted only for a step that's actually going to happen.
 * - "obs": a real step's result arrived — `ok` means a real observation
 *   came back at all (vs. a timeout/no-result), NOT that the underlying
 *   action itself succeeded (a "could not find that element" miss is
 *   still a real, arrived observation, `ok: true`) — don't conflate the
 *   two; a step's own success/failure lives in the observation text.
 * - "thk": Planner/Critic reasoning, narrated (e.g. the Critic's own
 *   `reasoning` on a verdict) — internal-only until a caller chooses to
 *   surface it.
 * - "inj": injected filler narration — e.g. today's rotating Talker ack
 *   phrase, now emitted as a real event instead of an inline side effect.
 */
export const AgentEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("act"), verb: VerbResponseSchema, at: z.number() }),
  z.object({ type: z.literal("obs"), observation: z.string(), ok: z.boolean(), at: z.number() }),
  z.object({ type: z.literal("thk"), text: z.string(), at: z.number() }),
  z.object({ type: z.literal("inj"), text: z.string(), at: z.number() }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

// Planner/Progress types (Phase 3 — see plan.ts's own doc comment for why
// this is a plain re-export, not inlined here: avoids a circular import).
export * from "./plan";

// The manifest schema and the runtime verb contract. Freeze these early —
// the indexer (writer) and the SDK (reader/validator) both import from here
// so the build-time and run-time halves of Cairn can't drift apart.

import { z } from "zod";

export const VERBS = ["explain", "highlight", "open", "navigate", "do", "tour"] as const;
export type Verb = (typeof VERBS)[number];

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

export const PageSchema = z.object({
  id: z.string(),
  route: z.string(),
  file: z.string(),
  title: z.string(),
  purpose: z.string(),
  whenToUse: z.string(),
  confidence: z.number().min(0).max(1),
  elements: z.array(ElementSchema),
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

export const VerbResponseSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("explain"), text: z.string().min(1) }).strict(),
  z
    .object({
      verb: z.literal("highlight"),
      target: z.string().min(1),
      text: optionalString(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("open"),
      target: z.string().min(1),
      text: optionalString(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("navigate"),
      route: z.string().min(1),
      text: optionalString(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("do"),
      action: z.string().min(1),
      /** What the action applies to, e.g. a manifest element id. Not every action needs one. */
      target: optionalString(),
      text: optionalString(),
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
            })
            .strict(),
        )
        .min(2)
        .max(6),
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
export const CopilotRequestSchema = z.object({
  route: z.string(),
  question: z.string().min(1),
  visible: z.array(z.string()),
  /** Prior turns of this same conversation, oldest first — untrusted data, same as `question`, never instructions. */
  history: z.array(HistoryTurnSchema).optional(),
});
export type CopilotRequest = z.infer<typeof CopilotRequestSchema>;

export function safeParseVerbResponse(data: unknown): VerbResponse | null {
  const result = VerbResponseSchema.safeParse(data);
  return result.success ? result.data : null;
}

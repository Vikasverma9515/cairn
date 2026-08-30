// The manifest schema and the runtime verb contract. Freeze these early —
// the indexer (writer) and the SDK (reader/validator) both import from here
// so the build-time and run-time halves of Cairn can't drift apart.

import { z } from "zod";

export const VERBS = ["explain", "highlight", "open", "navigate", "do"] as const;
export type Verb = (typeof VERBS)[number];

// ---------------------------------------------------------------------------
// Manifest (build-time output)
// ---------------------------------------------------------------------------

export const ElementSchema = z.object({
  id: z.string(),
  label: z.string(),
  selector: z.string(),
  fallbacks: z.array(z.string()),
  does: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
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

export const VerbResponseSchema = z.discriminatedUnion("verb", [
  z.object({ verb: z.literal("explain"), text: z.string().min(1) }).strict(),
  z
    .object({
      verb: z.literal("highlight"),
      target: z.string().min(1),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("open"),
      target: z.string().min(1),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("navigate"),
      route: z.string().min(1),
      text: z.string().optional(),
    })
    .strict(),
  z
    .object({
      verb: z.literal("do"),
      action: z.string().min(1),
      /** What the action applies to, e.g. a manifest element id. Not every action needs one. */
      target: z.string().optional(),
      text: z.string().optional(),
    })
    .strict(),
]);
export type VerbResponse = z.infer<typeof VerbResponseSchema>;

// The request context the runtime SDK sends to the customer's /api/copilot
// route, and that route forwards (trimmed) to the LLM.
export const CopilotRequestSchema = z.object({
  route: z.string(),
  question: z.string().min(1),
  visible: z.array(z.string()),
});
export type CopilotRequest = z.infer<typeof CopilotRequestSchema>;

export function safeParseVerbResponse(data: unknown): VerbResponse | null {
  const result = VerbResponseSchema.safeParse(data);
  return result.success ? result.data : null;
}

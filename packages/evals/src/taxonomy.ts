// The capability taxonomy — the "sub-task and divide" breakdown of what
// operating arbitrary software actually requires, so eval results can be
// aggregated BY CAPABILITY ("how good are we at multi-step goals") instead
// of only by scenario. Grounded in real precedent, not invented: WebArena's
// 4-category task taxonomy (info-seeking / navigation / content-ops /
// unachievable) plus τ-bench's policy-constraint and clarification-seeking
// dimensions — see the eval plan's research item #5 for the full citations.
//
// Every scenario declares which of these it exercises (scenario.ts's
// `capabilities` field); the dashboard's capability-breakdown view is a
// straight aggregate of pass rate grouped by tag.

export const CAPABILITY_TAGS = [
  "info-seeking",
  "navigation",
  "content-ops",
  "multi-step-composite",
  "unachievable",
  "policy-constraint",
  "ambiguous-clarify",
  "non-semantic-ui",
  "tool-use",
  "voice-realtime",
  "error-recovery",
] as const;

export type CapabilityTag = (typeof CAPABILITY_TAGS)[number];

export const CAPABILITY_DESCRIPTIONS: Record<CapabilityTag, string> = {
  "info-seeking": "Answers a real question from real page/app state (WebArena's information-seeking category).",
  navigation: "A single-step highlight/open/navigate to a known place.",
  "content-ops": "Create, edit, archive, or delete something real (WebArena's content/configuration operations).",
  "multi-step-composite": "A goal that needs several dependent real steps in sequence to complete.",
  unachievable: "The goal genuinely can't be done here — correct behavior is saying so, not guessing or clicking around (WebArena's 4th category).",
  "policy-constraint": "A stated business rule or limit the agent must respect while completing the goal (τ-bench).",
  "ambiguous-clarify": "An underspecified goal where asking a clarifying question is the correct move, not guessing.",
  "non-semantic-ui": "Dynamically-rendered, off-screen, or unlabeled elements — no data-ai, no semantic tag.",
  "tool-use": "A real WebMCP call_tool invocation, or a batched multi-action step.",
  "voice-realtime": "Turn-taking, latency, and barge-in over the realtime voice transport.",
  "error-recovery": "A real induced failure (missing element, API error, rate limit) and whether the agent degrades honestly instead of hallucinating success.",
};

export function isCapabilityTag(value: string): value is CapabilityTag {
  return (CAPABILITY_TAGS as readonly string[]).includes(value);
}

// Architecture Pillar 3 (Playbook half) — a generic, hand-authored hint per
// UI pattern (see ui-patterns.ts), consulted by the Planner as a STARTING
// POINT, never a rigid script: the Critic still verifies real state at
// every step regardless of what a Playbook suggested. This is the
// fallback/seed layer the plan's own design calls for — the self-authored,
// LEARNED Skill layer (compiled from a real Critic-verified task, stored
// per-deployment) is later work; these are written once, by us, ahead of
// time, and apply to any platform that matches the pattern, not one
// specific app.

import type { UiPatternId } from "./ui-patterns";

/** Ordered, natural-language hints — never a literal script of exact
 * selectors or steps (the model still has to resolve every target for
 * real, through the same element ladder as any other verb). */
export const PLAYBOOKS: Record<UiPatternId, string[]> = {
  "table-crud": [
    "Identify the target row by its real content (a name, an id, a status) from liveElements — never guess which row.",
    "Use that row's own action control for the requested change.",
    "Read the row back afterward to confirm the change actually happened before reporting success.",
  ],
  kanban: [
    "Find the real source card and the real destination column as elements, not by inference.",
    "Drag the card from its current position onto the destination column.",
    "Read the destination column afterward to confirm the card actually landed there — a drag can silently fail to register.",
  ],
  canvas: [
    "Add each required node first, one at a time, before wiring any connections.",
    "Configure a node's own fields (fill) before connecting it to another node — a connection to an unconfigured node is rarely the real goal.",
    "Check which connection mechanism this specific page actually uses (a select-based 'connects to' field, or a drag-to-connect handle) before choosing select vs. drag — don't assume.",
    "If a test/validate action exists, run it to confirm the graph is actually wired correctly before reporting success.",
  ],
  "search-filter": [
    "Type the real search/filter term into the real search field with fill.",
    "Read the results back afterward — only report what the page actually now shows, never what you expect it to show.",
  ],
  wizard: [
    "Complete each step's real required fields before advancing — don't skip ahead speculatively.",
    "Use the step's own next/continue/confirm action rather than guessing at a shortcut.",
    "Confirm the final step actually submitted (a real confirmation, order id, or status change) before reporting success.",
  ],
};

/** Renders a matched pattern's Playbook as one compact hint string for the
 * Planner's own userMessage — same "additive, only when there's something
 * real to say" discipline as resolvePlan's existing pages/actions fields. */
export function renderPlaybookHint(pattern: UiPatternId): string {
  return PLAYBOOKS[pattern].join(" ");
}

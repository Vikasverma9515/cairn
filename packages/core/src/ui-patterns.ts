// Architecture Pillar 2 — understanding a platform Cairn has never seen,
// not just one it pre-scanned. `cairn build` needs the target app's own
// source ahead of time — structurally impossible for a third-party
// platform Cairn doesn't own (n8n, e.g.). This module is the generalizable
// half of the fix: look at what's ACTUALLY on screen right now (the same
// LiveElement[] runtime-scan.ts already reports on every request — no new
// client wiring, no new schema field) and classify it against a small,
// fixed set of UI patterns any new platform's screens tend to map onto.
//
// Deliberately rule-based, not ML — every match carries its own concrete
// reasoning (which labels/roles triggered it), so a wrong classification is
// debuggable, not a black box, matching this codebase's own "never guess,
// always show real evidence" discipline elsewhere (the element ladder, the
// Critic). Ranked, not single-answer: a real page can genuinely match more
// than one pattern (a kanban board is also a repeated-card layout), and the
// caller (resolveVerb's system-prompt hint) can surface all of them or just
// the top one.
//
// Reuses the exact same pattern ids packages/evals/src/primitives/index.ts's
// PlaygroundPrimitive registry already established for its own genre
// taxonomy (table-crud, kanban, canvas, search-filter, wizard) — the plan's
// own build order calls for shipping this classifier against those EXISTING
// eval genres first, as a real, checkable target, before generalizing
// further. That registry stays test-only/build-time; this one runs for
// real, per-request, against whatever a live page's liveElements report.

// Deliberately does NOT import LiveElement from ./index — index.ts
// re-exports this file, and a two-way import would be the exact same
// circular-dependency risk plan.ts's own doc comment already avoids for
// the same reason. LiveElement's real shape ({id, role, label}) is stable
// and small enough to restate structurally here instead.
interface LiveElementLike {
  role: string;
  label: string;
}

export const UI_PATTERNS = ["table-crud", "kanban", "canvas", "search-filter", "wizard"] as const;
export type UiPatternId = (typeof UI_PATTERNS)[number];

/** The pure, DOM-free input the classifier consumes — derived once per
 * request from the SAME liveElements array already sent for every other
 * purpose (element resolution, the "what's on screen" system-prompt
 * section). No new client wiring, no new payload field. */
export interface PageStructureSignals {
  /** How many live elements report each role (e.g. {"button": 4, "input": 2}). */
  roleCounts: Record<string, number>;
  /** Every live element's own label, lowercased — the keyword signal. */
  labels: string[];
  totalElements: number;
}

export function deriveStructureSignals(elements: LiveElementLike[]): PageStructureSignals {
  const roleCounts: Record<string, number> = {};
  const labels: string[] = [];
  for (const el of elements) {
    roleCounts[el.role] = (roleCounts[el.role] ?? 0) + 1;
    labels.push(el.label.toLowerCase());
  }
  return { roleCounts, labels, totalElements: elements.length };
}

export interface UiPatternMatch {
  pattern: UiPatternId;
  /** Which real labels/roles triggered this match — concrete evidence, never a bare label. */
  reasoning: string;
}

function countLabelsContaining(labels: string[], needles: string[]): number {
  return labels.filter((label) => needles.some((needle) => label.includes(needle))).length;
}

function roleCount(signals: PageStructureSignals, ...roles: string[]): number {
  return roles.reduce((sum, role) => sum + (signals.roleCounts[role] ?? 0), 0);
}

/**
 * Classifies a page's live-scanned structure against the fixed pattern set
 * above. A page can genuinely match more than one pattern (returned ranked,
 * strongest evidence first) — this is a set of independent, real signals
 * checked in turn, not a single decision tree forcing one answer.
 */
export function classifyUiPattern(signals: PageStructureSignals): UiPatternMatch[] {
  const matches: UiPatternMatch[] = [];

  // canvas — a node/workflow-builder editor. "connects to" is the real,
  // concrete phrase this exact kind of UI uses for wiring two nodes
  // together (via a select OR a drag-connect handle — this signal doesn't
  // care which); "add node"/"canvas"/"workflow" cover the more generic case.
  const canvasHits = countLabelsContaining(signals.labels, ["connects to", "connect to", "add node", "canvas", "workflow"]);
  if (canvasHits > 0) {
    matches.push({ pattern: "canvas", reasoning: `${canvasHits} element label(s) reference connecting/adding nodes or a canvas/workflow.` });
  }

  // kanban — columns of cards, moved between them.
  const kanbanHits = countLabelsContaining(signals.labels, ["column", "move to", "board", " card"]);
  if (kanbanHits > 0) {
    matches.push({ pattern: "kanban", reasoning: `${kanbanHits} element label(s) reference columns/cards/moving between them.` });
  }

  // table-crud — several buttons doing the same real per-row action
  // (archive/delete/edit), no form fields anywhere on screen. Real,
  // repeated action labels are the concrete evidence, not just "there are
  // buttons" (every page has buttons).
  const repeatedActionWords = ["archive", "delete", "remove", "edit"];
  const repeatedActionCount = repeatedActionWords.reduce((sum, word) => {
    const hits = signals.labels.filter((label) => label.includes(word)).length;
    return sum + (hits >= 2 ? hits : 0);
  }, 0);
  if (repeatedActionCount >= 2 && roleCount(signals, "input", "textarea") === 0) {
    matches.push({ pattern: "table-crud", reasoning: `${repeatedActionCount} repeated row-action label(s) (archive/delete/edit) with no form fields on screen.` });
  }

  // search-filter — a real input whose own label says what it's for.
  const searchInputs = signals.labels.filter((label) => roleCount(signals, "input") > 0 && ["search", "filter", "query", "find"].some((needle) => label.includes(needle))).length;
  if (searchInputs > 0) {
    matches.push({ pattern: "search-filter", reasoning: `${searchInputs} input label(s) reference searching/filtering/querying.` });
  }

  // wizard — a step's own "continue"/"next"/"confirm"/"place order" action.
  const wizardHits = countLabelsContaining(signals.labels, ["continue", "next step", "confirm order", "place order", "checkout"]);
  if (wizardHits > 0) {
    matches.push({ pattern: "wizard", reasoning: `${wizardHits} element label(s) reference advancing/confirming a multi-step flow.` });
  }

  return matches;
}

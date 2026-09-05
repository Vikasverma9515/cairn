// Planner/Progress types for the multi-agent redesign (Phase 3) — see
// DEVELOPMENT.md's "Phase 3" entry and the plan file for the full design.
// A flat, ORDERED task list, not a DAG: Cairn's action surface is
// single-tab, sequential DOM manipulation (click/fill/read/call_tool/
// batch against one shared live page) with no evidence of needing real
// branching — navigate/tour inside a task don't imply the PLAN needs
// branches. Versioned so a real Planner revision is always a new
// version, never a silent in-place mutation (the real, named fix the
// scheduler-theoretic agent-loop literature calls out: "was this the
// original plan, or a silent in-place edit" is exactly the kind of
// question that shouldn't need re-deriving from a mutated object).
//
// Deliberately does NOT import from ./index (VerbResponseSchema etc.) —
// index.ts re-exports this file, and a two-way import would be a real
// circular-dependency risk given ESM's evaluation order. Any later step
// that needs to reference a verb inside a plan/event type should restructure
// around that constraint explicitly, not introduce the cycle.

import { z } from "zod";

export const TASK_STATUSES = ["pending", "in_progress", "done", "failed", "skipped"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TaskSchema = z
  .object({
    /** Short, stable id within one plan version, e.g. "t1". */
    id: z.string(),
    /** What this task achieves, in plain language — concrete enough to act on. */
    description: z.string().min(1),
    /** What counts as this task being ACTUALLY done, checkable against
     * real state — plain natural language (not a formal predicate
     * language on purpose: over-engineering a predicate DSL against
     * arbitrary third-party web apps is a real risk this avoids). */
    doneContract: z.string().min(1),
    status: z.enum(TASK_STATUSES),
  })
  .strict();
export type Task = z.infer<typeof TaskSchema>;

export const PlanSchema = z
  .object({
    /** Bumped only on a genuine Planner revision — never mutated in place. */
    version: z.number().int().min(1),
    goal: z.string().min(1),
    /** Real facts already known, relevant to the goal — Magentic-One's
     * slow-changing Task Ledger facts. Empty when there's nothing to carry forward. */
    facts: z.array(z.string()),
    tasks: z.array(TaskSchema).min(1),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

/** The fast, cheap, per-step state — regenerated every step, read by
 * anything that needs "where are we right now" without re-deriving it
 * from the full Plan/history (Magentic-One's Progress Ledger). */
export const ProgressLedgerSchema = z
  .object({
    /** Progress against a stale plan version is a bug, not a silent merge. */
    planVersion: z.number().int().min(1),
    currentTaskIndex: z.number().int().min(0),
    /** Consecutive "no real progress" verdicts on the CURRENT task —
     * crossing a bounded threshold is what escalates to a real replan
     * instead of retrying forever (step 3's Critic; unused until then). */
    stallCount: z.number().int().min(0),
  })
  .strict();
export type ProgressLedger = z.infer<typeof ProgressLedgerSchema>;

// ---------------------------------------------------------------------------
// The Planner's own raw output — deliberately narrower than Plan itself.
// `version` and each task's `status` are harness-owned bookkeeping (the
// model has no way to correctly reason about "is this v1 or v2," and
// status starts pending/in_progress by convention, not model judgment) —
// asking the model to produce them invites it to invent wrong values
// instead of leaving them to the code that actually tracks them.
// ---------------------------------------------------------------------------

export const PlannerOutputTaskSchema = z
  .object({
    id: z.string(),
    description: z.string().min(1),
    doneContract: z.string().min(1),
  })
  .strict();
export type PlannerOutputTask = z.infer<typeof PlannerOutputTaskSchema>;

export const PlannerOutputSchema = z
  .object({
    goal: z.string().min(1),
    facts: z.array(z.string()),
    tasks: z.array(PlannerOutputTaskSchema).min(1),
  })
  .strict();
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

// ---------------------------------------------------------------------------
// The Critic (Phase 3 step 3) — a genuinely separate pass over REAL
// resulting state, decoupled from the Executor's own self-report. This is
// the direct fix for the diagnosed bug (a batch of 2 clicks succeeded,
// and the model kept looping 4 more iterations before giving up, never
// recognizing its own success): "are we done" stops being purely "did the
// model pick a TERMINAL_VERBS verb" and becomes a real, independent check
// against the current task's own doneContract.
// ---------------------------------------------------------------------------

export const CRITIC_VERDICTS = ["continue", "task_complete", "replan", "give_up"] as const;
export type CriticVerdictKind = (typeof CRITIC_VERDICTS)[number];

export const CriticVerdictSchema = z
  .object({
    verdict: z.enum(CRITIC_VERDICTS),
    /** Only meaningful on "replan" — PIVOT's structured expected-vs-actual
     * diff, cheaper and more actionable for the next Planner call than a
     * full-context re-derivation. Absent for every other verdict. */
    expected: z.string().optional(),
    actual: z.string().optional(),
    /**
     * Architecture Pillar 3 (Skill half) — only meaningful on
     * "task_complete". A genuinely NEW, confirmed-true, PLATFORM-
     * structural fact this step's real outcome revealed (e.g. "the
     * canvas's node-connection field is a dropdown labeled 'connects to',
     * not a drag gesture" or "the search box needs about 300ms before
     * results update") — never a fact about any one user's own data,
     * enforced by the Critic's own system prompt (buildCriticSystemPrompt
     * in server.ts), not just by convention. This is the exact "which
     * steps were genuinely new/useful/confirmed-correct" signal Voyager's
     * own skill-library discipline requires: only a real, Critic-verified
     * outcome ever contributes a fact, never an unverified guess. Absent
     * when this step didn't teach anything worth remembering — the common
     * case, not an error.
     */
    learnedFact: z.string().optional(),
    reasoning: z.string().min(1),
  })
  .strict();
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;

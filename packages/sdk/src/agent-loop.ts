// The shared skeleton behind both agent-loop drivers — index.tsx's
// runTypedAgentLoop (HTTP/typed transport) and realtime-server.ts's
// finalizeTurn (WebSocket/voice relay) independently re-implemented the
// exact same "ask, check terminal, execute a continuing step for real,
// fold the result into working history, ask again, up to a hard
// iteration cap" shape — a real, live duplication risk (any future fix
// to one had to be remembered and re-applied to the other by hand).
// This module is the first step of the Phase 3 multi-agent redesign
// (see DEVELOPMENT.md/the plan file's "Phase 3" entry): extract exactly
// that shared shape, with ZERO behavior change, so Planner/Critic
// wiring in later steps has one real place to attach to instead of two.
//
// Deliberately does NOT own transport-specific side effects — sending a
// message to a client, speaking, committing to a connection's real
// cross-turn memory, barge-in cancellation timing. Those stay in each
// transport's own getNextStep/onStep/onStepResult/executeStep closures,
// and in what the caller does with this function's return value, exactly
// as before this extraction. Plain TypeScript only (no JSX, no Node
// built-ins) — imported as raw source by index.tsx's browser bundle AND
// compiled to dist/ for realtime-server.ts's Node build.

import { TERMINAL_VERBS, type AgentEvent, type CriticVerdict, type HistoryTurn, type VerbResponse } from "@cairnvibe/core";

/** 4 exchanges — matches the cap both original drivers independently used. */
export const MAX_HISTORY_TURNS = 8;

export function summarizeVerbForHistory(verb: VerbResponse): string {
  if ("text" in verb && verb.text) return verb.text;
  switch (verb.verb) {
    case "highlight":
    case "open":
      return `(highlighted ${verb.target})`;
    case "navigate":
      return `(navigated to ${verb.route})`;
    case "do":
      return `(ran ${verb.action}${verb.target ? ` on ${verb.target}` : ""})`;
    case "tour":
      return verb.steps.map((s) => s.text).join(" ");
    case "click":
      return `(clicked ${verb.target})`;
    case "fill":
      return `(typed "${verb.value}" into ${verb.target})`;
    case "read":
      return `(read ${verb.target})`;
    case "call_tool":
      return `(called ${verb.name})`;
    case "batch":
      return `(${verb.actions.length} steps: ${verb.actions.map((a) => a.verb).join(", ")})`;
    default:
      return "(no response)";
  }
}

export interface AgentLoopStepEvent {
  verb: VerbResponse;
  /** 0-based. */
  iteration: number;
  /** True if this verb is a TERMINAL_VERBS member — will end the loop
   * right after this hook returns. Lets a caller act differently for a
   * continuing vs. final step without re-deriving TERMINAL_VERBS itself. */
  terminal: boolean;
}

export interface AgentLoopStepResultEvent {
  verb: VerbResponse;
  iteration: number;
  observation: string | null | undefined;
}

export interface AgentLoopDeps {
  /** Resolve the next step given the CURRENT working history. Return
   * `null` for a response that failed to parse/validate — the HTTP
   * path's own real case (a raw fetch response might not conform);
   * realtime's in-process resolveVerb never produces this, since it
   * always returns a valid VerbResponse itself. A null return ends the
   * loop immediately with outcome "unparseable". */
  getNextStep(loopHistory: HistoryTurn[], iteration: number): Promise<VerbResponse | null>;
  /** Fires immediately after getNextStep resolves, before the terminal/
   * continuing branch is decided — the real-time side-effect point (send
   * the verb to a client, trigger an ack on the first continuing step,
   * check for a superseding barge-in). Returning true aborts the loop
   * immediately: no further side effects, outcome "aborted". */
  onStep?(event: AgentLoopStepEvent): boolean | Promise<boolean>;
  /** Execute a continuing verb (click/fill/read/call_tool/batch) for
   * real; return its observation text (or null/undefined for "no
   * result", folded into history as "no result" exactly like both
   * original drivers already did). */
  executeStep(verb: VerbResponse, iteration: number): Promise<string | null | undefined>;
  /** Fires after executeStep resolves, before folding the observation
   * into working history — a second real-time abort checkpoint (e.g. a
   * barge-in generation check after awaiting a real tool result, which
   * can itself take a while). Returning true aborts the loop with
   * outcome "aborted", discarding this step's observation. */
  onStepResult?(event: AgentLoopStepResultEvent): boolean | Promise<boolean>;
  /**
   * Phase 3 step 3 — a genuinely separate pass over the step's REAL
   * observation, decoupled from the Executor/model's own self-report
   * (the direct fix for the diagnosed bug: a batch succeeded and the
   * model kept looping instead of recognizing it). Fires after
   * onStepResult/the history fold. Returning a "task_complete" or
   * "give_up" verdict ends the loop right here — even though the
   * model's own verb was never a TERMINAL_VERBS member — instead of
   * asking the model again and hoping it notices. Returning "continue"
   * (including after the caller's own closure has silently handled a
   * "replan" by fetching a fresh Plan — driveAgentLoop itself has no
   * concept of a Plan, only of "keep going or stop") keeps the loop
   * going exactly as if this hook were absent. Returning null/undefined
   * behaves the same as "continue" — a caller can choose not to run the
   * Critic on a particular step without a special no-op verdict shape.
   */
  runCritic?(event: AgentLoopStepResultEvent): Promise<CriticVerdict | null | undefined>;
  /**
   * Phase 3 step 5 — a pure, fire-and-forget event consumer for a
   * Talker-style narration layer ("Revisable by Design"'s pattern):
   * never awaited, never able to affect control flow. driveAgentLoop
   * itself emits "act" (right after a step's onStep/abort check passes —
   * only for a verb that's actually going to execute, never a discarded
   * one) and "obs" (right after onStepResult's own abort check passes),
   * since it already has that data at exactly those points. A caller's
   * own onStep/runCritic closures can call this SAME callback directly —
   * it's just a plain reference they already have via the deps object
   * they constructed — to emit "thk" (Critic reasoning) or "inj"
   * (injected filler narration, e.g. a Talker ack phrase) events too;
   * driveAgentLoop has no opinion on those.
   */
  onEvent?(event: AgentEvent): void;
  /** Defaults to 6 — a hard cap, not a target, matching both original drivers. */
  maxIterations?: number;
}

export type AgentLoopOutcome =
  | { outcome: "terminal"; finalVerb: VerbResponse; workingHistory: HistoryTurn[] }
  /** The Critic independently confirmed the (last) task's doneContract
   * is satisfied — the real fix for the diagnosed bug. The caller
   * synthesizes its own terminal-shaped response (e.g. `{verb: "explain",
   * text: verdict.reasoning}`) from `verdict`, same as it would for a
   * model-produced terminal verb. */
  | { outcome: "critic-complete"; verdict: CriticVerdict; workingHistory: HistoryTurn[] }
  /** The Critic (or the harness's own stall-count fail-safe, inside the
   * caller's runCritic closure) decided continuing wouldn't help. */
  | { outcome: "critic-give-up"; verdict: CriticVerdict; workingHistory: HistoryTurn[] }
  | { outcome: "unparseable"; workingHistory: HistoryTurn[] }
  | { outcome: "gave-up"; workingHistory: HistoryTurn[] }
  | { outcome: "aborted"; workingHistory: HistoryTurn[] };

export async function driveAgentLoop(initialHistory: HistoryTurn[], deps: AgentLoopDeps): Promise<AgentLoopOutcome> {
  const maxIterations = deps.maxIterations ?? 6;
  let loopHistory = initialHistory;

  for (let i = 0; i < maxIterations; i++) {
    const verb = await deps.getNextStep(loopHistory, i);
    if (verb === null) return { outcome: "unparseable", workingHistory: loopHistory };

    const terminal = TERMINAL_VERBS.has(verb.verb);
    if (deps.onStep) {
      const abort = await deps.onStep({ verb, iteration: i, terminal });
      if (abort) return { outcome: "aborted", workingHistory: loopHistory };
    }
    deps.onEvent?.({ type: "act", verb, at: Date.now() });

    if (terminal) {
      return { outcome: "terminal", finalVerb: verb, workingHistory: loopHistory };
    }

    const observation = await deps.executeStep(verb, i);
    if (deps.onStepResult) {
      const abort = await deps.onStepResult({ verb, iteration: i, observation });
      if (abort) return { outcome: "aborted", workingHistory: loopHistory };
    }
    deps.onEvent?.({ type: "obs", observation: observation ?? "no result", ok: observation !== null && observation !== undefined, at: Date.now() });

    loopHistory = [
      ...loopHistory,
      { role: "assistant" as const, text: `${summarizeVerbForHistory(verb)}. Result: ${observation ?? "no result"}` },
    ].slice(-MAX_HISTORY_TURNS);

    if (deps.runCritic) {
      const verdict = await deps.runCritic({ verb, iteration: i, observation });
      if (verdict?.verdict === "task_complete") return { outcome: "critic-complete", verdict, workingHistory: loopHistory };
      if (verdict?.verdict === "give_up") return { outcome: "critic-give-up", verdict, workingHistory: loopHistory };
      // "continue", "replan" (already handled inside the caller's own
      // runCritic closure — see this field's own doc comment), or no
      // verdict at all: fall through and keep looping, unchanged.
    }
  }

  return { outcome: "gave-up", workingHistory: loopHistory };
}

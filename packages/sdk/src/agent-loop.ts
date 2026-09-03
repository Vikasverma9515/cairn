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

import { TERMINAL_VERBS, type HistoryTurn, type VerbResponse } from "@cairnvibe/core";

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
  /** Defaults to 6 — a hard cap, not a target, matching both original drivers. */
  maxIterations?: number;
}

export type AgentLoopOutcome =
  | { outcome: "terminal"; finalVerb: VerbResponse; workingHistory: HistoryTurn[] }
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

    if (terminal) {
      return { outcome: "terminal", finalVerb: verb, workingHistory: loopHistory };
    }

    const observation = await deps.executeStep(verb, i);
    if (deps.onStepResult) {
      const abort = await deps.onStepResult({ verb, iteration: i, observation });
      if (abort) return { outcome: "aborted", workingHistory: loopHistory };
    }

    loopHistory = [
      ...loopHistory,
      { role: "assistant" as const, text: `${summarizeVerbForHistory(verb)}. Result: ${observation ?? "no result"}` },
    ].slice(-MAX_HISTORY_TURNS);
  }

  return { outcome: "gave-up", workingHistory: loopHistory };
}

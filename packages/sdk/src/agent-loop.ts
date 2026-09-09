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

import { isTerminalVerb, type AgentEvent, type CriticVerdict, type HistoryTurn, type VerbResponse } from "@cairnvibe/core";

/** 4 exchanges — matches the cap both original drivers independently used. */
export const MAX_HISTORY_TURNS = 8;

/**
 * Architecture Pillar 4 — a cheap, LOCAL signal for "this goal probably
 * needs more than one real step," checked BEFORE the first step even
 * runs, so a caller can start the Planner call in PARALLEL with the
 * first getNextStep instead of only after that first step already came
 * back non-terminal (the "lazy gate" the plan singles out for
 * replacement — realtime-server.ts's own onStep used to build planPromise
 * only once `!terminal && iteration === 0` was already true, one full
 * model round trip later than it needed to be). Deliberately
 * conservative, on purpose: a false negative here just falls back to
 * that same lazy-after-step-1 behavior — unchanged, zero regression —
 * while a false positive costs one Planner call that would have started
 * a moment later anyway, never a wrong answer. Genuine UI-pattern-aware
 * classification (Pillar 2, not built yet) can replace this heuristic
 * later without changing what calls it. Lives here (not server.ts) so
 * BOTH transports can use the exact same check: this file is plain,
 * dependency-free TypeScript imported as raw source by index.tsx's
 * browser bundle AND compiled for realtime-server.ts's Node build — a
 * server-only file (server.ts imports the Anthropic/Groq SDKs) can never
 * be imported from the client widget.
 */
// Widened once, live-found (not theoretical): a real "create an agent that
// could call the patient and check if they're okay" was missed entirely by
// the original connector-word-only version (no "then"/"after that" anywhere
// in it) — a create/build/set-up goal described by WHAT it should end up
// doing ("that can/could/should/would ..."), not by narrating its own
// steps, is exactly as multi-step as one with explicit sequencing words,
// and just as common a real phrasing. Still deliberately conservative and
// cheap (no model call) — see this function's own doc comment above for
// why a false negative here is zero-regression (falls back to the lazy,
// after-step-1 kickoff) while a false positive only costs one Planner call
// starting a moment earlier than it otherwise would.
const MULTI_STEP_SIGNAL =
  /\b(then|after that|once (you|it|that|i)|and then|next,|first[,.]? .*\bthen\b|(create|build|set up|make) (a|an|.*) .*\b(that|which|who) (can|could|should|would)\b)\b/;
export function looksMultiStep(question: string): boolean {
  return MULTI_STEP_SIGNAL.test(question.toLowerCase());
}

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
    case "drag":
      return `(dragged ${verb.target} to ${verb.to})`;
    case "select":
      return `(selected "${verb.value}" in ${verb.target})`;
    case "key":
      return `(pressed ${verb.key}${verb.target ? ` on ${verb.target}` : ""})`;
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
  /** True if isTerminalVerb(verb) says this ends the loop right after
   * this hook returns (TERMINAL_VERBS membership, except a navigate
   * marked continueAfter — see isTerminalVerb's own doc comment). Lets a
   * caller act differently for a continuing vs. final step without
   * re-deriving that check itself. */
  terminal: boolean;
}

export interface AgentLoopStepResultEvent {
  verb: VerbResponse;
  iteration: number;
  observation: string | null | undefined;
  /** True when this is the terminal-verb Critic check (see driveAgentLoop's
   * own terminal branch) rather than a continuing step's real execution
   * result. A caller's runCritic closure needs this explicitly — checking
   * `observation === undefined` isn't reliable, since a continuing step's
   * own executeStep can legitimately return undefined too ("no result").
   * A closure should use this to decide whether it's safe to SKIP the
   * check (no Plan already active/in-flight for this turn — see
   * runCritic's own doc comment for why forcing one into existence just
   * to critic-check an ordinary one-turn answer like "hello" would be a
   * real, live-relevant latency regression, not a theoretical one). */
  terminal: boolean;
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
  // 25, not 6 — the real, live-found ceiling on a genuine multi-step goal
  // (a real deployment reported a ~20-step "build me a voice agent for X"
  // task hitting "gave-up" long before it could finish, even though the
  // Planner/Critic themselves were working correctly). The stall fail-safe
  // inside each caller's own runCritic closure (STALL_THRESHOLD, 3
  // non-progressing attempts) is the actual thing that stops a genuinely
  // broken loop — this cap only needs to be high enough to never be the
  // limiting factor on a real, progressing goal.
  const maxIterations = deps.maxIterations ?? 25;
  let loopHistory = initialHistory;

  for (let i = 0; i < maxIterations; i++) {
    const verb = await deps.getNextStep(loopHistory, i);
    if (verb === null) return { outcome: "unparseable", workingHistory: loopHistory };

    const terminal = isTerminalVerb(verb);
    if (deps.onStep) {
      const abort = await deps.onStep({ verb, iteration: i, terminal });
      if (abort) return { outcome: "aborted", workingHistory: loopHistory };
    }
    deps.onEvent?.({ type: "act", verb, at: Date.now() });

    if (terminal) {
      // Real, live-found bug this closes: a terminal verb (the model
      // deciding to just ANSWER, e.g. "explain") used to return
      // immediately, before runCritic was even reachable — so the one
      // failure mode 2026 agent research calls out by name
      // (self-evaluation bias: an agent's own claim of success, ungraded
      // by anything else, is frequently wrong) had NO check at all on the
      // most common path an answer actually ships through. Only runs when
      // a caller actually wired a Critic (deps.runCritic present) — a
      // deployment with no Planner/Critic configured behaves exactly as
      // before, zero regression. `observation` is intentionally
      // undefined: a terminal verb has no separate execution result the
      // way a continuing verb does — summarizeVerbForHistory(verb)
      // (folded into "action" server-side) already carries the model's
      // own claim, which is exactly what's being scrutinized here.
      if (deps.runCritic) {
        const verdict = await deps.runCritic({ verb, iteration: i, observation: undefined, terminal: true });
        if (verdict?.verdict === "task_complete") {
          return { outcome: "terminal", finalVerb: verb, workingHistory: loopHistory };
        }
        if (verdict?.verdict === "give_up") {
          return { outcome: "critic-give-up", verdict, workingHistory: loopHistory };
        }
        if (verdict) {
          // "continue" (or "replan", already coerced to "continue" by the
          // caller's own closure — see AgentLoopDeps.runCritic's doc
          // comment) — the Critic caught a claim that doesn't actually
          // satisfy the task, so it doesn't ship. Fold the rejection and
          // WHY into history, exactly like a continuing step's real
          // observation, so the next getNextStep call has real, specific
          // feedback to correct against instead of repeating the same
          // unverified claim.
          loopHistory = [
            ...loopHistory,
            { role: "assistant" as const, text: `${summarizeVerbForHistory(verb)}. (Not actually complete yet: ${verdict.reasoning})` },
          ].slice(-MAX_HISTORY_TURNS);
          deps.onEvent?.({ type: "obs", observation: `Not actually complete yet: ${verdict.reasoning}`, ok: false, at: Date.now() });
          continue;
        }
        // No verdict at all (runCritic returned null/undefined — a
        // caller's own choice not to check this particular terminal
        // answer, e.g. no active Plan yet) — ship it unchecked, same as
        // before this fix existed.
      }
      return { outcome: "terminal", finalVerb: verb, workingHistory: loopHistory };
    }

    const observation = await deps.executeStep(verb, i);
    if (deps.onStepResult) {
      const abort = await deps.onStepResult({ verb, iteration: i, observation, terminal: false });
      if (abort) return { outcome: "aborted", workingHistory: loopHistory };
    }
    deps.onEvent?.({ type: "obs", observation: observation ?? "no result", ok: observation !== null && observation !== undefined, at: Date.now() });

    loopHistory = [
      ...loopHistory,
      { role: "assistant" as const, text: `${summarizeVerbForHistory(verb)}. Result: ${observation ?? "no result"}` },
    ].slice(-MAX_HISTORY_TURNS);

    if (deps.runCritic) {
      const verdict = await deps.runCritic({ verb, iteration: i, observation, terminal: false });
      if (verdict?.verdict === "task_complete") return { outcome: "critic-complete", verdict, workingHistory: loopHistory };
      if (verdict?.verdict === "give_up") return { outcome: "critic-give-up", verdict, workingHistory: loopHistory };
      // "continue", "replan" (already handled inside the caller's own
      // runCritic closure — see this field's own doc comment), or no
      // verdict at all: fall through and keep looping, unchanged.
    }
  }

  return { outcome: "gave-up", workingHistory: loopHistory };
}

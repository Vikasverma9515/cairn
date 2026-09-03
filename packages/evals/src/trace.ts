// The full, real record of one scenario run — captured, not summarized, so
// judge.ts and the stored history have everything: every verb, every real
// tool observation, every LLM round trip, and (voice runs) real per-stage
// latency, laid directly against the voice-primer stage budget the eval
// plan is measured against.

export interface CopilotRoundTrip {
  requestBody: unknown;
  responseBody: unknown;
  requestedAt: number;
  respondedAt: number;
}

export interface VoiceFrame {
  direction: "sent" | "received";
  /** Parsed JSON payload for a control frame; "[binary]" for a raw audio frame. */
  data: unknown;
  at: number;
}

export interface VoiceLatencies {
  /** ms from starting mic playback to the first "final" transcript. */
  micToTranscriptMs: number | null;
  /** ms from the first "final" transcript to the first "verb" message. */
  transcriptToDecisionMs: number | null;
  /** ms from the "verb" message to the first "audio_chunk" (or
   * "turn_complete" for a verb with nothing spoken). */
  decisionToFirstAudioMs: number | null;
  /** ms from mic playback start to the first audible response byte. */
  totalMs: number | null;
}

/** One line of a simulated-user conversation (scenario.ts's
 * SimulatedUserConfig) — kept as a clean turn-by-turn transcript
 * alongside the raw `copilotRoundTrips`, so the judge and the dashboard's
 * trace viewer can read the actual back-and-forth without re-deriving it
 * from request/response JSON. */
export interface ConversationTurn {
  speaker: "simulated-user" | "agent";
  text: string;
}

export interface ScenarioRunResult {
  scenarioId: string;
  transport: "typed" | "voice";
  startedAt: string;
  /** Real final state, fetched from the scenario's own verify.path after
   * the run — this is what task-success actually gets judged against. */
  finalState: unknown;
  achieved: boolean;
  copilotRoundTrips: CopilotRoundTrip[];
  voiceFrames?: VoiceFrame[];
  voiceLatencies?: VoiceLatencies;
  /** Populated only for a simulated-user scenario — the real turn-by-turn
   * transcript, ending either because the simulated user signaled the
   * goal was met/stuck, or `maxTurns` was reached. */
  conversation?: ConversationTurn[];
  /** Anything that made the run itself fail to complete (a timeout, a
   * thrown error) — distinct from the agent failing the actual task. */
  runError?: string;
}

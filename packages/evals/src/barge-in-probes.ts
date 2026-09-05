// Real, end-to-end barge-in probes — the piece the plain scenario suite
// can't cover, because Scenario.verify checks the app's FINAL state after
// a turn completes, not real-time behavior DURING one. These probes drive
// the exact same real browser/real fake-mic/real WebSocket machinery as
// runner.ts, but assert on the live WS frame timeline instead: does a
// real, sustained "stop" utterance played mid-answer actually produce a
// real client->server barge_in message (proving the local VAD +
// createBargeInGate + triggerBargeIn wiring works end to end, not just in
// vad.test.ts's pure-function unit tests), and does a real noise burst
// mid-answer NOT produce one (proving no false-positive interruption).
//
// Exists specifically to close the gap named in DEVELOPMENT.md's own
// "Gate barge-in on sustained speech" entry: that fix was unit-tested in
// isolation (createBargeInGate's own pure logic) but never exercised
// through the real browser AudioContext/ScriptProcessorNode/WebSocket
// pipeline a live user actually goes through.
import { chromium, type Page } from "playwright";
import { installFakeMic, injectMicNoise, injectMicSpeech } from "./fake-mic";
import { installVoiceFrameCapture, openWidget, runVoiceTurn } from "./runner";
import { synthesizeSpeech } from "./synthesize";
import type { VoiceFrame } from "./trace";

export type BargeInProbeKind = "interrupt" | "noise";

export interface BargeInProbeResult {
  probeId: string;
  kind: BargeInProbeKind;
  /** When a real "speaking_start" frame was observed — null if the agent
   * never started speaking within the timeout (a real run failure,
   * distinct from a barge-in pass/fail verdict). */
  speakingStartAt: number | null;
  /** When the probe injected its clip (real "stop" speech, or noise). */
  injectedAt: number;
  /** When the client actually sent {type:"barge_in"} after injection —
   * null if it never did. */
  bargeInSentAt: number | null;
  /** Whether real turn activity (audio_chunk/speaking_end/turn_complete)
   * was still observed well after injection — supplementary evidence for
   * the "noise" case that the turn genuinely continued undisturbed, not
   * load-bearing for pass/fail on its own (a short answer can legitimately
   * finish before the grace window elapses either way). */
  sawTurnContinueAfterInjection: boolean;
  passed: boolean;
  reasoning: string;
}

// Long enough to guarantee the agent is still mid-answer when the probe
// injects (a one-word answer would finish before there's anything to
// interrupt) — mirrors the real user-reported bug's own "give me an
// overview" shape.
const OPENING_GOAL = "Please give me a full, detailed overview of everything you can help me with on this page.";
const STOP_UTTERANCE = "Stop, stop, wait.";
const NOISE_BURST_MS = 300;

const DEFAULT_SPEAKING_START_TIMEOUT_MS = 25_000;
const DEFAULT_SETTLE_INTO_SPEECH_MS = 500;
const DEFAULT_GRACE_MS = 1500;

export interface RunBargeInProbeOptions {
  deepgramApiKey: string;
  baseUrl: string;
  path: string;
  headless?: boolean;
  /** How long to wait for a real "speaking_start" frame before giving up
   * — a real Groq/TTS call can be slow; this is not the barge-in timing
   * budget itself. */
  speakingStartTimeoutMs?: number;
  /** How long into real agent speech to wait before injecting — long
   * enough that real audio is actively playing (not just the first
   * chunk), short enough the answer hasn't already finished. */
  settleIntoSpeechMs?: number;
  /** How long after injection to keep watching before scoring. */
  graceMs?: number;
}

/** Drives one real barge-in probe end to end: opens the real widget,
 * starts a real realtime turn with a long-answer-inducing question, waits
 * for the agent to actually start speaking, then injects either a real
 * sustained "stop" utterance or a noise burst — timed off the REAL
 * observed speaking_start frame, never a fixed guess, since LLM/TTS
 * latency varies too much to predict. */
export async function runBargeInProbe(kind: BargeInProbeKind, probeId: string, options: RunBargeInProbeOptions): Promise<BargeInProbeResult> {
  const speakingStartTimeoutMs = options.speakingStartTimeoutMs ?? DEFAULT_SPEAKING_START_TIMEOUT_MS;
  const settleIntoSpeechMs = options.settleIntoSpeechMs ?? DEFAULT_SETTLE_INTO_SPEECH_MS;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;

  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const context = await browser.newContext();
    const page: Page = await context.newPage();
    const voiceFrames: VoiceFrame[] = [];
    installVoiceFrameCapture(page, voiceFrames);

    const openingAudio = await synthesizeSpeech(OPENING_GOAL, { apiKey: options.deepgramApiKey });
    await installFakeMic(page, openingAudio.toString("base64"));

    await page.goto(new URL(options.path, options.baseUrl).toString(), { waitUntil: "networkidle" });
    await openWidget(page);
    await runVoiceTurn(page);

    const speakingStartAt = await waitForFrame(voiceFrames, isFrameType("speaking_start", "received"), speakingStartTimeoutMs);
    if (speakingStartAt === null) {
      return {
        probeId,
        kind,
        speakingStartAt: null,
        injectedAt: Date.now(),
        bargeInSentAt: null,
        sawTurnContinueAfterInjection: false,
        passed: false,
        reasoning: `The agent never started speaking within ${speakingStartTimeoutMs}ms — can't probe barge-in against a turn that never started answering.`,
      };
    }

    await page.waitForTimeout(settleIntoSpeechMs);
    const injectedAt = Date.now();

    if (kind === "interrupt") {
      const stopAudio = await synthesizeSpeech(STOP_UTTERANCE, { apiKey: options.deepgramApiKey });
      await injectMicSpeech(page, stopAudio.toString("base64"));
    } else {
      await injectMicNoise(page, NOISE_BURST_MS);
    }

    await page.waitForTimeout(graceMs + 500); // real settle window so the last relevant frames have time to arrive before scoring
    return { probeId, ...evaluateBargeInProbe(kind, voiceFrames, speakingStartAt, injectedAt, graceMs) };
  } finally {
    await browser.close();
  }
}

function isFrameType(type: string, direction: "sent" | "received") {
  return (f: VoiceFrame) => f.direction === direction && typeof f.data === "object" && f.data !== null && (f.data as { type?: unknown }).type === type;
}

async function waitForFrame(frames: VoiceFrame[], predicate: (f: VoiceFrame) => boolean, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = frames.find(predicate);
    if (found) return found.at;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The real pass/fail logic, factored out as a pure function over a
 * captured WS frame timeline — exported and unit-tested directly (see
 * barge-in-probes.test.ts) without needing a real browser or API keys, the
 * same "test the pure decision logic in isolation" pattern runner.ts's own
 * computeVoiceLatencies/matchesExpectation already follow. */
export function evaluateBargeInProbe(
  kind: BargeInProbeKind,
  voiceFrames: VoiceFrame[],
  speakingStartAt: number | null,
  injectedAt: number,
  graceMs: number = DEFAULT_GRACE_MS,
): Omit<BargeInProbeResult, "probeId"> {
  const bargeInFrame = voiceFrames.find((f) => isFrameType("barge_in", "sent")(f) && f.at >= injectedAt);
  const bargeInSentAt = bargeInFrame?.at ?? null;

  const isTurnActivity = (f: VoiceFrame) =>
    f.direction === "received" &&
    typeof f.data === "object" &&
    f.data !== null &&
    ["audio_chunk", "speaking_end", "turn_complete"].includes((f.data as { type?: unknown }).type as string);
  const sawTurnContinueAfterInjection = voiceFrames.some((f) => isTurnActivity(f) && f.at > injectedAt + graceMs);

  if (kind === "interrupt") {
    const passed = bargeInSentAt !== null && bargeInSentAt - injectedAt <= graceMs;
    return {
      kind,
      speakingStartAt,
      injectedAt,
      bargeInSentAt,
      sawTurnContinueAfterInjection,
      passed,
      reasoning:
        bargeInSentAt === null
          ? `No barge_in was ever sent within ${graceMs}ms of injecting sustained "stop" speech — the local VAD/gate failed to recognize a real interruption.`
          : passed
            ? `Sustained "stop" speech triggered a real barge_in ${bargeInSentAt - injectedAt}ms after injection.`
            : `barge_in arrived ${bargeInSentAt - injectedAt}ms after injection, outside the ${graceMs}ms grace window.`,
    };
  }

  const passed = bargeInSentAt === null;
  return {
    kind,
    speakingStartAt,
    injectedAt,
    bargeInSentAt,
    sawTurnContinueAfterInjection,
    passed,
    reasoning: passed
      ? `A noise burst mid-answer did not trigger a false barge_in${sawTurnContinueAfterInjection ? " — the turn continued normally afterward" : ""}.`
      : `A noise burst mid-answer incorrectly triggered barge_in ${bargeInSentAt! - injectedAt}ms after injection — a false positive.`,
  };
}

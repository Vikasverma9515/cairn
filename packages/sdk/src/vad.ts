// A lightweight, dependency-free voice-activity heuristic for client-side
// barge-in detection — replaces a bare RMS-amplitude threshold with a
// two-feature (energy + zero-crossing rate) gate plus an adaptive ambient
// noise floor, entirely in plain JS math over the same Float32Array PCM
// samples the ScriptProcessorNode already delivers. No model, no WASM, no
// added bundle weight — the real alternative to a neural VAD (e.g. Silero)
// this session's own research flagged as carrying a genuine ~1-2MB/
// 20-30x bundle-size cost for a widget meant to drop into a third-party
// page (see DEVELOPMENT.md, Phase 2 step 2's Pending section) — this
// avoids that tradeoff entirely rather than deciding it.
//
// Energy alone (the prior BARGE_IN_RMS_THRESHOLD design) fires on ANY
// loud sound — a cough, a door slam, background music, a raised-volume
// TV. Zero-crossing rate distinguishes broadly speech-plausible content
// (voiced pitch + its harmonics, unvoiced fricatives) from the two
// extremes most likely to false-trigger a bare energy gate: a low-
// frequency hum/rumble (near-zero ZCR) and broadband hiss/static-like
// noise (ZCR near its ceiling). The ZCR band below is deliberately wide
// — it only rejects those two extremes, not a precise speech classifier
// — and, like the original RMS threshold, is not calibrated against real
// hardware in this environment (no live mic here); a reasonable starting
// point, not a tuned production value.
//
// The adaptive noise floor is the other real improvement over a flat
// threshold: instead of one fixed absolute RMS cutoff, the energy gate
// tracks a slow-moving estimate of the room's own ambient level (updated
// only on frames NOT classified as speech) and requires real speech to
// clear a multiple of it — a noisy room raises the bar automatically
// instead of the old constant threshold false-triggering on ambient
// noise all the time.

const ABSOLUTE_MIN_RMS = 0.02; // same floor as the original flat threshold — never MORE sensitive than before in a quiet room
const NOISE_FLOOR_MULTIPLIER = 3; // real speech must clear 3x the ambient floor, not just the absolute minimum
const NOISE_FLOOR_EMA_ALPHA = 0.05; // slow-moving — ~1.7s time constant at a 4096-sample/48kHz frame, so a rising voice isn't mistaken for a rising ambient floor
const MIN_ZCR = 0.003; // rejects near-DC hum/rumble; well below any real voiced-speech fundamental's crossing rate
const MAX_ZCR = 0.4; // rejects hiss/static-like broadband noise (pure white noise sits near 0.5)

export interface VadFrameResult {
  isSpeech: boolean;
  rms: number;
  zcr: number;
  noiseFloor: number;
}

export interface VadDetector {
  process(samples: Float32Array): VadFrameResult;
  reset(): void;
}

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) sumSquares += samples[i] * samples[i];
  return Math.sqrt(sumSquares / samples.length);
}

// Fraction of adjacent-sample sign changes, in [0, 1] — a coarse
// frequency-content proxy that needs no FFT: near 0 for a slow/DC-ish
// signal, near 1 for a signal that changes sign every sample (Nyquist-
// rate content, the discrete analogue of white noise/hiss).
export function computeZcr(samples: Float32Array): number {
  if (samples.length < 2) return 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] >= 0 !== samples[i - 1] >= 0) crossings++;
  }
  return crossings / (samples.length - 1);
}

export function createVadDetector(): VadDetector {
  let noiseFloor = 0;

  return {
    process(samples: Float32Array): VadFrameResult {
      const rms = computeRms(samples);
      const zcr = computeZcr(samples);

      const energyThreshold = Math.max(ABSOLUTE_MIN_RMS, noiseFloor * NOISE_FLOOR_MULTIPLIER);
      const isSpeech = rms > energyThreshold && zcr >= MIN_ZCR && zcr <= MAX_ZCR;

      if (!isSpeech) noiseFloor = noiseFloor * (1 - NOISE_FLOOR_EMA_ALPHA) + rms * NOISE_FLOOR_EMA_ALPHA;

      return { isSpeech, rms, zcr, noiseFloor };
    },
    reset() {
      noiseFloor = 0;
    },
  };
}

// A live-reported bug traced this session (see DEVELOPMENT.md) to a
// server-side "confirm-or-reverse" barge-in design that raced Deepgram's
// own transcript against a fixed grace window — real, deliberate
// interruptions routinely lost that race and got treated as false
// positives. Removing that system fixed the false "resumes from the
// top," but left barge-in firing on a SINGLE ~85-100ms VAD frame
// (createVadDetector's own frame-classification granularity at the
// 4096-sample ScriptProcessorNode buffer size in use) — a single cough
// or door-slam frame that happens to pass the energy+ZCR gate still cuts
// the agent off, permanently now, with no recovery at all.
//
// Real research into how production voice-agent platforms actually solve
// this (Pipecat, LiveKit Agents, Vapi, Deepgram's own Voice Agent API —
// see DEVELOPMENT.md for the full comparison) converges on the same
// answer, independent of any STT-transcript race: gate the LOCAL VAD
// trigger on SUSTAINED speech across a minimum duration, not a single
// frame. Pipecat's own documented production spec cites a 250ms minimum
// duration; Vapi's stopSpeakingPlan defaults its VAD-duration threshold
// (voiceSeconds) to 0.2s specifically to "balance responsiveness and
// avoid false triggers." This is the same idea, entirely client-side —
// unlike the removed server-side design, it never waits on a network
// round trip or Deepgram's own transcript timing, so it can't reintroduce
// that exact race. A brief, real noise burst (a cough, a single loud
// clack) essentially never sustains cleanly across multiple consecutive
// frames at these energy/ZCR bands; genuine speech does.
const BARGE_IN_MIN_SPEECH_MS = 200;

export interface BargeInGate {
  /** Feed one frame's VAD classification plus that frame's real duration
   * (samples.length / sampleRate * 1000 — NOT assumed, since sample rate
   * varies by device/browser). Returns true the instant accumulated
   * consecutive speech crosses the minimum-duration threshold — fires
   * exactly once per sustained speech onset. Any non-speech frame resets
   * the accumulator immediately, so a genuine interruption still cuts in
   * well under half a second, while an isolated noise burst (which
   * essentially never sustains across consecutive frames) never fires at
   * all. */
  update(frame: VadFrameResult, frameDurationMs: number): boolean;
  reset(): void;
}

export function createBargeInGate(minSpeechMs: number = BARGE_IN_MIN_SPEECH_MS): BargeInGate {
  let accumulatedMs = 0;
  let fired = false;

  return {
    update(frame, frameDurationMs) {
      if (!frame.isSpeech) {
        accumulatedMs = 0;
        fired = false;
        return false;
      }
      accumulatedMs += frameDurationMs;
      if (fired || accumulatedMs < minSpeechMs) return false;
      fired = true;
      return true;
    },
    reset() {
      accumulatedMs = 0;
      fired = false;
    },
  };
}

import { describe, expect, it } from "vitest";
import { computeRms, computeZcr, createBargeInGate, createVadDetector, type VadFrameResult } from "./vad";

describe("computeRms", () => {
  it("returns 0 for silence", () => {
    expect(computeRms(new Float32Array(64))).toBe(0);
  });

  it("returns the constant magnitude for a constant-amplitude signal", () => {
    expect(computeRms(new Float32Array(100).fill(0.3))).toBeCloseTo(0.3, 6);
  });

  it("returns the amplitude for a signal alternating between +a and -a", () => {
    const samples = new Float32Array(100);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 0.5 : -0.5;
    expect(computeRms(samples)).toBeCloseTo(0.5, 6);
  });

  it("returns 0 for an empty array", () => {
    expect(computeRms(new Float32Array(0))).toBe(0);
  });
});

describe("computeZcr", () => {
  it("returns 0 for a constant-sign signal — no crossings at all", () => {
    expect(computeZcr(new Float32Array(100).fill(0.4))).toBe(0);
  });

  it("returns 1 for a signal that flips sign every sample — every adjacent pair crosses", () => {
    const samples = new Float32Array(50);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 1 : -1;
    expect(computeZcr(samples)).toBe(1);
  });

  it("counts exactly one crossing for a signal that flips sign once, midway through", () => {
    const samples = new Float32Array(20);
    for (let i = 0; i < samples.length; i++) samples[i] = i < 10 ? 1 : -1;
    // 19 adjacent pairs total, exactly 1 of them (index 9->10) crosses
    expect(computeZcr(samples)).toBeCloseTo(1 / 19, 10);
  });

  it("returns 0 for fewer than 2 samples", () => {
    expect(computeZcr(new Float32Array(1))).toBe(0);
    expect(computeZcr(new Float32Array(0))).toBe(0);
  });
});

// A period-8 square wave (4 samples positive, 4 negative, repeated) gives a
// zero-crossing rate comfortably inside the detector's speech-plausible
// band — used below as a stand-in for "speech-like" content without
// needing real recorded audio (none is available in this environment).
function speechLikeFrame(length: number, amplitude: number): Float32Array {
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) samples[i] = Math.floor(i / 4) % 2 === 0 ? amplitude : -amplitude;
  return samples;
}

function humFrame(length: number, amplitude: number): Float32Array {
  return new Float32Array(length).fill(amplitude); // constant sign — zcr = 0
}

describe("createVadDetector", () => {
  it("does not flag silence as speech", () => {
    const vad = createVadDetector();
    const result = vad.process(new Float32Array(4096));
    expect(result.isSpeech).toBe(false);
  });

  it("flags a loud, speech-band-frequency frame as speech", () => {
    const vad = createVadDetector();
    const result = vad.process(speechLikeFrame(4096, 0.3));
    expect(result.isSpeech).toBe(true);
    expect(result.zcr).toBeGreaterThan(0.003);
    expect(result.zcr).toBeLessThan(0.4);
  });

  it("does NOT flag a loud low-frequency hum as speech — zcr too low", () => {
    const vad = createVadDetector();
    const result = vad.process(humFrame(4096, 0.3));
    expect(result.isSpeech).toBe(false);
    expect(result.zcr).toBe(0);
  });

  it("does NOT flag loud Nyquist-rate noise (every-sample sign flip) as speech — zcr too high", () => {
    const vad = createVadDetector();
    const samples = new Float32Array(4096);
    for (let i = 0; i < samples.length; i++) samples[i] = i % 2 === 0 ? 0.3 : -0.3;
    const result = vad.process(samples);
    expect(result.isSpeech).toBe(false);
    expect(result.zcr).toBe(1);
  });

  it("does not flag a quiet speech-band frame as speech — below the absolute energy floor", () => {
    const vad = createVadDetector();
    const result = vad.process(speechLikeFrame(4096, 0.005));
    expect(result.isSpeech).toBe(false);
  });

  it("adapts the noise floor upward from repeated ambient (non-speech) frames, raising the bar for what counts as speech", () => {
    const primed = createVadDetector();
    for (let i = 0; i < 60; i++) primed.process(humFrame(4096, 0.06));
    const primedResult = primed.process(speechLikeFrame(4096, 0.09));

    const fresh = createVadDetector();
    const freshResult = fresh.process(speechLikeFrame(4096, 0.09));

    // The identical speech-band frame at rms=0.09 is accepted by a fresh
    // detector (0.09 clears the absolute 0.02 floor) but rejected by one
    // that has adapted to a 0.06 ambient floor (0.09 doesn't clear 3x0.06).
    expect(freshResult.isSpeech).toBe(true);
    expect(primedResult.isSpeech).toBe(false);
    expect(primedResult.noiseFloor).toBeGreaterThan(freshResult.noiseFloor);
  });

  it("reset() clears the adapted noise floor back to a fresh detector's behavior", () => {
    const vad = createVadDetector();
    for (let i = 0; i < 60; i++) vad.process(humFrame(4096, 0.06));
    expect(vad.process(speechLikeFrame(4096, 0.09)).isSpeech).toBe(false);

    vad.reset();
    expect(vad.process(speechLikeFrame(4096, 0.09)).isSpeech).toBe(true);
  });

  it("never lets the energy gate drop below the original absolute RMS floor, even with zero prior noise", () => {
    const vad = createVadDetector();
    const result = vad.process(speechLikeFrame(4096, 0.021));
    expect(result.isSpeech).toBe(true); // just above the 0.02 absolute floor
  });
});

function speechFrame(): VadFrameResult {
  return { isSpeech: true, rms: 0.3, zcr: 0.05, noiseFloor: 0 };
}

function nonSpeechFrame(): VadFrameResult {
  return { isSpeech: false, rms: 0.01, zcr: 0.05, noiseFloor: 0.01 };
}

describe("createBargeInGate", () => {
  it("does not fire on a single speech frame shorter than the minimum duration", () => {
    const gate = createBargeInGate(200);
    // One 85ms frame — well under the 200ms floor.
    expect(gate.update(speechFrame(), 85)).toBe(false);
  });

  it("fires once accumulated CONSECUTIVE speech crosses the minimum duration — real, sustained speech, not a single burst", () => {
    const gate = createBargeInGate(200);
    expect(gate.update(speechFrame(), 85)).toBe(false); // 85ms
    expect(gate.update(speechFrame(), 85)).toBe(false); // 170ms
    expect(gate.update(speechFrame(), 85)).toBe(true); // 255ms — crosses 200ms
  });

  it("fires exactly once per sustained onset, not on every frame after crossing the threshold", () => {
    const gate = createBargeInGate(200);
    gate.update(speechFrame(), 85);
    gate.update(speechFrame(), 85);
    expect(gate.update(speechFrame(), 85)).toBe(true);
    expect(gate.update(speechFrame(), 85)).toBe(false); // already fired for this onset
    expect(gate.update(speechFrame(), 85)).toBe(false);
  });

  it("real bug this closes: an isolated single-frame noise burst (cough, door slam) never fires — it doesn't sustain across consecutive frames", () => {
    const gate = createBargeInGate(200);
    expect(gate.update(speechFrame(), 85)).toBe(false); // the burst's one loud frame
    expect(gate.update(nonSpeechFrame(), 85)).toBe(false); // silence again — the burst already ended
    expect(gate.update(nonSpeechFrame(), 85)).toBe(false);
  });

  it("any non-speech frame resets the accumulator — a brief pause mid-utterance restarts the count instead of carrying over stale progress", () => {
    const gate = createBargeInGate(200);
    gate.update(speechFrame(), 85); // 85ms
    gate.update(speechFrame(), 85); // 170ms — close to firing
    gate.update(nonSpeechFrame(), 85); // reset to 0
    expect(gate.update(speechFrame(), 85)).toBe(false); // only 85ms since the reset
    expect(gate.update(speechFrame(), 85)).toBe(false); // 170ms
    expect(gate.update(speechFrame(), 85)).toBe(true); // 255ms — crosses 200ms
  });

  it("reset() clears in-progress accumulation and re-arms an onset that already fired", () => {
    const gate = createBargeInGate(200);
    gate.update(speechFrame(), 85);
    gate.update(speechFrame(), 85);
    expect(gate.update(speechFrame(), 85)).toBe(true); // fired once

    gate.reset();
    expect(gate.update(speechFrame(), 85)).toBe(false); // starts over from 0ms
    expect(gate.update(speechFrame(), 85)).toBe(false);
    expect(gate.update(speechFrame(), 85)).toBe(true); // fires again after re-accumulating
  });

  it("defaults to 200ms — matching the real production defaults found in Vapi's stopSpeakingPlan (voiceSeconds: 0.2s default) and inside Pipecat's documented 250ms production spec's own range", () => {
    const gate = createBargeInGate(); // no explicit minSpeechMs
    expect(gate.update(speechFrame(), 199)).toBe(false);
    expect(gate.update(speechFrame(), 1)).toBe(true); // crosses 200ms exactly
  });
});

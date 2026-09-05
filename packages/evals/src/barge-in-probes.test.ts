import { describe, expect, it } from "vitest";
import { evaluateBargeInProbe } from "./barge-in-probes";
import type { VoiceFrame } from "./trace";

function frame(direction: "sent" | "received", data: unknown, at: number): VoiceFrame {
  return { direction, data, at };
}

describe("evaluateBargeInProbe", () => {
  describe("kind: interrupt", () => {
    it("passes when a real barge_in is sent shortly after injecting sustained 'stop' speech", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [
        frame("received", { type: "speaking_start" }, 5000),
        frame("received", { type: "audio_chunk" }, 5100),
        frame("sent", { type: "barge_in" }, 10_260), // 260ms after injection — well inside the gate's ~200ms sustain + processing overhead
      ];
      const result = evaluateBargeInProbe("interrupt", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(true);
      expect(result.bargeInSentAt).toBe(10_260);
      expect(result.reasoning).toMatch(/triggered a real barge_in/);
    });

    it("fails when no barge_in is ever sent — the local VAD/gate missed a real interruption", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [
        frame("received", { type: "speaking_start" }, 5000),
        frame("received", { type: "audio_chunk" }, 10_500),
        frame("received", { type: "speaking_end" }, 12_000),
      ];
      const result = evaluateBargeInProbe("interrupt", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(false);
      expect(result.bargeInSentAt).toBeNull();
      expect(result.reasoning).toMatch(/No barge_in was ever sent/);
    });

    it("fails when barge_in arrives, but outside the grace window — too slow to count as a real, responsive interruption", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [frame("sent", { type: "barge_in" }, 10_000 + 1500 + 1)];
      const result = evaluateBargeInProbe("interrupt", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toMatch(/outside the 1500ms grace window/);
    });

    it("ignores a barge_in sent BEFORE injection (e.g. from an earlier, unrelated moment) — only counts one that arrives after the real injection time", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [
        frame("sent", { type: "barge_in" }, 9000), // stale, before the probe injected anything
      ];
      const result = evaluateBargeInProbe("interrupt", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(false);
      expect(result.bargeInSentAt).toBeNull();
    });
  });

  describe("kind: noise", () => {
    it("passes when a noise burst triggers no barge_in at all", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [
        frame("received", { type: "speaking_start" }, 5000),
        frame("received", { type: "audio_chunk" }, 10_100),
        frame("received", { type: "audio_chunk" }, 11_800),
        frame("received", { type: "speaking_end" }, 12_000),
      ];
      const result = evaluateBargeInProbe("noise", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(true);
      expect(result.bargeInSentAt).toBeNull();
      expect(result.sawTurnContinueAfterInjection).toBe(true);
      expect(result.reasoning).toMatch(/did not trigger a false barge_in/);
    });

    it("fails when a noise burst incorrectly triggers a real barge_in — a false positive", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [frame("sent", { type: "barge_in" }, 10_150)];
      const result = evaluateBargeInProbe("noise", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(false);
      expect(result.reasoning).toMatch(/false positive/);
    });

    it("still passes even if the turn happened to finish before the grace window elapsed — a short answer ending naturally is not a false positive", () => {
      const injectedAt = 10_000;
      const frames: VoiceFrame[] = [frame("received", { type: "turn_complete" }, 10_050)];
      const result = evaluateBargeInProbe("noise", frames, 5000, injectedAt, 1500);
      expect(result.passed).toBe(true);
      expect(result.sawTurnContinueAfterInjection).toBe(false); // no activity survives past injectedAt + graceMs, but that alone doesn't fail it
    });
  });

  it("never confuses a non-JSON-object frame (raw audio, already filtered upstream, but defensive here too) for a real barge_in/turn-activity frame", () => {
    const injectedAt = 10_000;
    const frames: VoiceFrame[] = [frame("sent", "[binary]", 10_100)];
    const result = evaluateBargeInProbe("interrupt", frames, 5000, injectedAt, 1500);
    expect(result.passed).toBe(false);
    expect(result.bargeInSentAt).toBeNull();
  });
});

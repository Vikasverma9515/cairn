import { describe, expect, it } from "vitest";
import { computeVoiceLatencies, extractAgentText, matchesExpectation } from "./runner";
import type { VoiceFrame } from "./trace";

describe("matchesExpectation", () => {
  it("passes when every needle appears in the JSON-stringified final state", () => {
    const state = { nodes: [{ type: "trigger-form-submitted" }, { type: "action-send-email", config: { to: "ops@example.com" } }] };
    expect(matchesExpectation(state, ["trigger-form-submitted", "ops@example.com"])).toBe(true);
  });

  it("fails when any needle is missing", () => {
    const state = { nodes: [{ type: "trigger-form-submitted" }] };
    expect(matchesExpectation(state, ["trigger-form-submitted", "action-send-email"])).toBe(false);
  });

  it("accepts a single string as well as an array", () => {
    expect(matchesExpectation({ status: "Archived" }, "Archived")).toBe(true);
    expect(matchesExpectation({ status: "Overdue" }, "Archived")).toBe(false);
  });

  it("never false-positives on null/undefined final state", () => {
    expect(matchesExpectation(null, "Archived")).toBe(false);
    expect(matchesExpectation(undefined, "Archived")).toBe(false);
  });
});

describe("computeVoiceLatencies", () => {
  function frame(direction: "sent" | "received", data: unknown, at: number): VoiceFrame {
    return { direction, data, at };
  }

  it("real bug this specifically guards against: computes each stage from the real frame sequence, not from arrival order alone", () => {
    const voiceStartedAt = 1000;
    const frames: VoiceFrame[] = [
      frame("sent", {}, 1050), // raw mic control frame, no "type" — ignored by isType()
      frame("received", { type: "interim", text: "how" }, 1100),
      frame("received", { type: "final", text: "how many invoices" }, 1300),
      frame("received", { type: "verb", verb: { verb: "explain", text: "three" } }, 1600),
      frame("received", { type: "audio_chunk", audio: "..." }, 1750),
    ];
    const latencies = computeVoiceLatencies(voiceStartedAt, frames);
    expect(latencies).toEqual({
      micToTranscriptMs: 300, // 1300 - 1000
      transcriptToDecisionMs: 300, // 1600 - 1300
      decisionToFirstAudioMs: 150, // 1750 - 1600
      totalMs: 750, // 1750 - 1000
    });
  });

  it("falls back to turn_complete for the first-audio marker when a verb has nothing spoken", () => {
    const voiceStartedAt = 1000;
    const frames: VoiceFrame[] = [
      frame("received", { type: "final", text: "highlight the button" }, 1200),
      frame("received", { type: "verb", verb: { verb: "highlight", target: "x" } }, 1400),
      frame("received", { type: "turn_complete" }, 1450),
    ];
    const latencies = computeVoiceLatencies(voiceStartedAt, frames);
    expect(latencies.decisionToFirstAudioMs).toBe(50);
    expect(latencies.totalMs).toBe(450);
  });

  it("returns null for any stage whose frames never arrived, instead of a misleading number", () => {
    const latencies = computeVoiceLatencies(1000, [frame("received", { type: "interim", text: "how" }, 1100)]);
    expect(latencies).toEqual({
      micToTranscriptMs: null,
      transcriptToDecisionMs: null,
      decisionToFirstAudioMs: null,
      totalMs: null,
    });
  });

  it("returns all-null when voiceStartedAt itself is null (the voice turn never actually started)", () => {
    const latencies = computeVoiceLatencies(null, [frame("received", { type: "final", text: "x" }, 1100)]);
    expect(latencies.micToTranscriptMs).toBeNull();
    expect(latencies.totalMs).toBeNull();
  });
});

describe("extractAgentText", () => {
  it("reads the top-level text field a real verb response carries (COMPANION_FIELDS.text)", () => {
    expect(extractAgentText({ verb: "explain", text: "I'm not sure how to help with that." })).toBe("I'm not sure how to help with that.");
  });

  it("joins per-step text for a tour response, which has no top-level text", () => {
    const tourResponse = { verb: "tour", steps: [{ target: "a", text: "First, click here." }, { target: "b", text: "Then here." }] };
    expect(extractAgentText(tourResponse)).toBe("First, click here. Then here.");
  });

  it("returns null for a verb response with nothing spoken (e.g. a plain click/fill with no text)", () => {
    expect(extractAgentText({ verb: "click", target: "archive-btn" })).toBeNull();
  });

  it("never throws on null/malformed response bodies — a simulated-user turn should stop cleanly, not crash the run", () => {
    expect(extractAgentText(null)).toBeNull();
    expect(extractAgentText(undefined)).toBeNull();
    expect(extractAgentText("not an object")).toBeNull();
    expect(extractAgentText({ verb: "tour", steps: "not an array" })).toBeNull();
  });
});

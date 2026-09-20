import { describe, expect, it } from "vitest";
import { retryDelayMs, withRateLimitWait, type VerbLLM } from "./server";

const rateLimited = (message = "Rate limit reached. Please try again in 2s.") => Object.assign(new Error(message), { status: 429 });

describe("withRateLimitWait", () => {
  it("waits the provider's hinted interval, then retries and succeeds instead of failing the task", async () => {
    let calls = 0;
    const slept: number[] = [];
    const llm: VerbLLM = { respond: async () => { if (++calls < 3) throw rateLimited(); return { verb: "explain", text: "ok" }; } };

    const out = await withRateLimitWait(llm, { sleep: async (ms) => void slept.push(ms) }).respond("s", "u");

    expect(out).toEqual({ verb: "explain", text: "ok" });
    expect(calls).toBe(3);
    expect(slept).toEqual([2250, 2250]);
  });

  it("gives up after maxWaits so a permanent limit cannot loop forever", async () => {
    const llm: VerbLLM = { respond: async () => { throw rateLimited(); } };
    await expect(withRateLimitWait(llm, { maxWaits: 2, sleep: async () => {} }).respond("s", "u")).rejects.toThrow(/Rate limit/);
  });

  it("fails fast when the provider asks for a long wait", async () => {
    let calls = 0;
    const llm: VerbLLM = { respond: async () => { calls++; throw rateLimited("Please try again in 45.8s"); } };
    await expect(withRateLimitWait(llm, { sleep: async () => {} }).respond("s", "u")).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("never retries an oversized request, and never touches other errors", async () => {
    let calls = 0;
    const tooLarge = Object.assign(new Error("Request too large for model"), { status: 413 });
    const llm: VerbLLM = { respond: async () => { calls++; throw tooLarge; } };
    await expect(withRateLimitWait(llm, { sleep: async () => {} }).respond("s", "u")).rejects.toThrow(/too large/);
    expect(calls).toBe(1);
  });
});

describe("retryDelayMs", () => {
  it("reads Groq's message, Gemini's retryDelay and the Retry-After header", () => {
    expect(retryDelayMs(new Error("Please try again in 45.8s"))).toBe(45800);
    expect(retryDelayMs({ message: "quota", error: { details: [{ retryDelay: "12s" }] } })).toBe(12000);
    expect(retryDelayMs({ headers: { "retry-after": "7" } })).toBe(7000);
    expect(retryDelayMs(new Error("boom"))).toBeUndefined();
  });
});

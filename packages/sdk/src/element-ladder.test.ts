import { describe, expect, it } from "vitest";
import { findElementWithRetry } from "./element-ladder";

describe("findElementWithRetry (Phase 3 step 4 — bounded, LLM-free Executor retry)", () => {
  it("real positive case: a transient miss (element not yet in the snapshot) recovers on the retry once it becomes available — the exact 'stale re-render' shape this exists to handle", async () => {
    const liveElements = new Map<string, any>();
    const fakeEl = { tagName: "BUTTON" };
    // Simulates a re-render populating the real element shortly after the
    // first lookup — a real async event, not a synchronous mutation.
    setTimeout(() => liveElements.set("archive-btn", fakeEl), 5);

    const result = await findElementWithRetry("archive-btn", liveElements, 2, 20);
    expect(result).toBe(fakeEl);
  });

  it("real negative case: a genuinely broken target still fails after all attempts — never silently invented, never masked as success", async () => {
    const liveElements = new Map<string, any>();
    const result = await findElementWithRetry("does-not-exist", liveElements, 2, 5);
    expect(result).toBeNull();
  });

  it("succeeds immediately with no retry delay at all when the element is already there — the common case pays no extra latency", async () => {
    const fakeEl = { tagName: "BUTTON" };
    const liveElements = new Map<string, any>([["archive-btn", fakeEl]]);
    const start = Date.now();
    const result = await findElementWithRetry("archive-btn", liveElements, 2, 500);
    expect(result).toBe(fakeEl);
    expect(Date.now() - start).toBeLessThan(100); // no delay was ever awaited
  });

  it("respects a real, bounded attempts count — never retries forever", async () => {
    const liveElements = new Map<string, any>();
    let elapsedChecks = 0;
    const originalSetTimeout = global.setTimeout;
    // Count how many real delay windows actually elapsed, to confirm the
    // loop stops at the given bound rather than looping unboundedly.
    global.setTimeout = ((fn: () => void, ms?: number) => {
      elapsedChecks++;
      return originalSetTimeout(fn, ms);
    }) as unknown as typeof setTimeout;

    try {
      await findElementWithRetry("x", liveElements, 3, 1);
    } finally {
      global.setTimeout = originalSetTimeout;
    }
    // 3 attempts means 2 real waits between them (never a wait after the
    // final attempt — no point delaying before giving up).
    expect(elapsedChecks).toBe(2);
  });
});

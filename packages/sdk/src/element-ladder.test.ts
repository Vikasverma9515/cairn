import { afterEach, describe, expect, it, vi } from "vitest";
import { findElementWithRetry, waitForDomSettle } from "./element-ladder";

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

// A minimal, hand-rolled MutationObserver stand-in — no jsdom dependency in
// this repo, and this repo's own tests already stub just enough of the DOM
// API surface for what each test needs (verb-executor.test.ts's
// withWindowStub is the same pattern) rather than reaching for a real
// browser environment.
class FakeMutationObserver {
  static instances: FakeMutationObserver[] = [];
  callback: () => void;
  disconnected = false;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeMutationObserver.instances.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
  trigger() {
    this.callback();
  }
}

describe("waitForDomSettle — real bug this closes: fill/click reported 'done' before the app's own async re-render (a filtered list, a cart count) had actually happened, so an immediately-following read saw stale content", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    FakeMutationObserver.instances = [];
  });

  it("resolves immediately when document/MutationObserver aren't available — the real fallback for a Node/test environment or a partial document stub (found live: a test stubbing document for an unrelated reason broke this with 'MutationObserver is not defined')", async () => {
    vi.stubGlobal("document", { modelContext: {} }); // a real shape another test in this repo already stubs — no `body`, no MutationObserver
    const start = Date.now();
    await waitForDomSettle();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves after initialWaitMs with no extra delay when the action triggered no mutation at all — the common case pays only the floor cost, not the full quiet window", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const promise = waitForDomSettle(100, 200, 1500);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it("waits for quietMs of no further mutations once real mutations start, instead of resolving on the very first one", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const promise = waitForDomSettle(100, 200, 1500);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    FakeMutationObserver.instances[0].trigger(); // a real mutation arrives before initialWaitMs elapses
    await vi.advanceTimersByTimeAsync(199);
    expect(resolved).toBe(false); // still inside the quiet window since the mutation
    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
  });

  it("keeps resetting the quiet window while mutations keep arriving — never settles on a page that's still actively changing", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const promise = waitForDomSettle(100, 200, 1500);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(10);
    const observer = FakeMutationObserver.instances[0];
    observer.trigger();
    await vi.advanceTimersByTimeAsync(150);
    observer.trigger(); // resets the 200ms quiet window before it would have fired
    await vi.advanceTimersByTimeAsync(150);
    expect(resolved).toBe(false); // only 150ms quiet since the last mutation — not enough yet
    await vi.advanceTimersByTimeAsync(60);
    expect(resolved).toBe(true);
  });

  it("never waits past the hard timeoutMs ceiling even if mutations never stop — a page with an animation or a polling widget can't stall the agent loop forever", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const promise = waitForDomSettle(100, 200, 1500);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    const observer = FakeMutationObserver.instances[0];
    // First mutation at t=10 (before the initialWaitMs=100 "no mutation at
    // all" timer would otherwise fire and resolve early), then one every
    // 100ms after that — would never naturally reach a 200ms quiet window
    // on its own. Stops at t=1410 (under the 1500ms cap) so the last
    // mutation's own quiet window (would resolve at 1610) is what the hard
    // cap has to preempt instead.
    await vi.advanceTimersByTimeAsync(10);
    observer.trigger();
    for (let i = 0; i < 14; i++) {
      await vi.advanceTimersByTimeAsync(100);
      observer.trigger();
    }
    expect(resolved).toBe(false); // t=1410, cap is at t=1500 — not yet
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true); // t=1510 — the hard cap fired regardless of ongoing mutations
  });

  it("disconnects the observer once settled — never leaves it running after resolving", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { body: {} });
    vi.stubGlobal("MutationObserver", FakeMutationObserver);

    const promise = waitForDomSettle(100, 200, 1500);
    await vi.advanceTimersByTimeAsync(102);
    await promise;
    expect(FakeMutationObserver.instances[0].disconnected).toBe(true);
  });
});

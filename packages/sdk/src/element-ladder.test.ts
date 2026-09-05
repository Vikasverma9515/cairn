import { afterEach, describe, expect, it, vi } from "vitest";
import { dragElement, findElementWithRetry, pressKey, selectOption, waitForDomSettle } from "./element-ladder";

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

describe("selectOption — Pillar 1's select verb", () => {
  afterEach(() => vi.unstubAllGlobals());

  function fakeSelect(optionPairs: { text: string; value: string }[]) {
    return {
      tagName: "SELECT",
      value: "",
      options: optionPairs.map((o) => ({ textContent: o.text, value: o.value })),
      dispatchEvent: vi.fn(),
    } as unknown as HTMLSelectElement;
  }

  it("native select: sets .value to the matching option's real value and fires input+change, matched by exact visible text", () => {
    const select = fakeSelect([
      { text: "Paid", value: "PAID" },
      { text: "Overdue", value: "OVERDUE" },
    ]);
    expect(selectOption(select, "Overdue")).toBe(true);
    expect(select.value).toBe("OVERDUE");
    expect(select.dispatchEvent).toHaveBeenCalledTimes(2);
  });

  it("native select: falls back to a substring match when no option's text matches exactly", () => {
    const select = fakeSelect([{ text: "Overdue (3 invoices)", value: "OVERDUE" }]);
    expect(selectOption(select, "Overdue")).toBe(true);
    expect(select.value).toBe("OVERDUE");
  });

  it("native select: reports failure instead of guessing when nothing matches", () => {
    const select = fakeSelect([{ text: "Paid", value: "PAID" }]);
    expect(selectOption(select, "Cancelled")).toBe(false);
  });

  it("custom listbox (role=option descendants): clicks the matching option instead of setting .value", () => {
    const optionA = { textContent: "Small", click: vi.fn() };
    const optionB = { textContent: "Large", click: vi.fn() };
    const el = {
      tagName: "DIV",
      querySelectorAll: vi.fn(() => [optionA, optionB]),
    } as unknown as HTMLElement;
    expect(selectOption(el, "Large")).toBe(true);
    expect(optionB.click).toHaveBeenCalledTimes(1);
    expect(optionA.click).not.toHaveBeenCalled();
  });

  it("custom listbox: reports failure when no descendant's text matches", () => {
    const el = {
      tagName: "DIV",
      querySelectorAll: vi.fn(() => []),
    } as unknown as HTMLElement;
    expect(selectOption(el, "Anything")).toBe(false);
  });
});

describe("dragElement — Pillar 1's drag verb, the concrete fix for canvas/kanban/sortable-list platforms", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Hand-rolled stand-ins, same reasoning as FakeMutationObserver above —
  // Node has no real MouseEvent/PointerEvent constructors at all (unlike
  // Event, which Node does provide), so real browser code exercising them
  // needs a fake to run under this repo's plain-Node test environment.
  class FakeMouseEvent {
    type: string;
    clientX: number;
    clientY: number;
    constructor(type: string, opts: { clientX: number; clientY: number }) {
      this.type = type;
      this.clientX = opts.clientX;
      this.clientY = opts.clientY;
    }
  }
  class FakePointerEvent extends FakeMouseEvent {}

  function fakeDraggable(rect: { left: number; top: number; width: number; height: number }) {
    return {
      getBoundingClientRect: () => rect,
      dispatchEvent: vi.fn(),
    } as unknown as HTMLElement;
  }

  it("fires a real mousedown -> mousemove(s) -> mouseup sequence from the source's center to the destination's center", () => {
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    const from = fakeDraggable({ left: 0, top: 0, width: 20, height: 20 }); // center (10, 10)
    const to = fakeDraggable({ left: 100, top: 100, width: 20, height: 20 }); // center (110, 110)

    dragElement(from, to, 2);

    const fromEvents = (from.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as FakeMouseEvent);
    const toEvents = (to.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as FakeMouseEvent);

    expect(fromEvents[0].type).toBe("mousedown");
    expect(fromEvents[0].clientX).toBe(10);
    expect(fromEvents[0].clientY).toBe(10);
    // Last mousemove and the mouseup both land on the real destination center.
    expect(toEvents.some((e) => e.type === "mousemove" && e.clientX === 110 && e.clientY === 110)).toBe(true);
    expect(toEvents.some((e) => e.type === "mouseup" && e.clientX === 110 && e.clientY === 110)).toBe(true);
  });

  it("also fires the pointer-event variant when PointerEvent exists — for canvas libraries (dnd-kit, n8n-style editors) that only listen for those", () => {
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    vi.stubGlobal("PointerEvent", FakePointerEvent);
    const from = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
    const to = fakeDraggable({ left: 50, top: 50, width: 10, height: 10 });

    dragElement(from, to, 1);

    const fromEvents = (from.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as FakeMouseEvent);
    expect(fromEvents.some((e) => e.type === "pointerdown")).toBe(true);
    expect(fromEvents.some((e) => e.type === "mousedown")).toBe(true);
  });

  it("skips pointer events entirely when PointerEvent isn't available — never throws", () => {
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    const from = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
    const to = fakeDraggable({ left: 50, top: 50, width: 10, height: 10 });
    expect(() => dragElement(from, to, 1)).not.toThrow();
  });
});

describe("pressKey — Pillar 1's key verb", () => {
  afterEach(() => vi.unstubAllGlobals());

  class FakeKeyboardEvent {
    type: string;
    key: string;
    constructor(type: string, opts: { key: string }) {
      this.type = type;
      this.key = opts.key;
    }
  }

  function fakeFocusable() {
    return { focus: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLElement;
  }

  it("focuses the target first, then fires a real keydown/keyup pair", () => {
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    const el = fakeFocusable();
    pressKey(el, "Escape");
    expect(el.focus).toHaveBeenCalledTimes(1);
    const events = (el.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as FakeKeyboardEvent);
    expect(events.map((e) => e.type)).toEqual(["keydown", "keyup"]);
    expect(events.every((e) => e.key === "Escape")).toBe(true);
  });

  it("Enter/Tab also fire a keypress in between, matching real browser behavior — pure navigation keys (arrows) don't get one", () => {
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    const el = fakeFocusable();
    pressKey(el, "Enter");
    const types = (el.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as FakeKeyboardEvent).type);
    expect(types).toEqual(["keydown", "keypress", "keyup"]);
  });
});

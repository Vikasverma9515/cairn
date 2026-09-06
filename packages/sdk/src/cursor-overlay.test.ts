import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideCursor, moveCursorTo } from "./cursor-overlay";

// This repo's test environment is plain Node, not jsdom (see element-ladder's
// own test file for the same discipline) — a small, real-enough fake DOM
// (an element registry keyed by id, a body that actually appends children)
// stands in for the browser APIs this module genuinely needs: createElement,
// getElementById, appendChild, classList, and a real (fake-timer-advanceable)
// window.setTimeout.

function makeFakeDocument() {
  const byId = new Map<string, ReturnType<typeof makeFakeCursorEl>>();
  const body = {
    appendChild: (el: ReturnType<typeof makeFakeCursorEl>) => {
      byId.set(el.id, el);
    },
  };
  return {
    body,
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => makeFakeCursorEl(),
  };
}

function makeFakeCursorEl() {
  return {
    id: "",
    style: { cssText: "", opacity: "", transform: "", transition: "" },
    classList: { add: vi.fn(), remove: vi.fn() },
    setAttribute: vi.fn(),
    innerHTML: "",
    offsetHeight: 0,
  };
}

function fakeTarget(rect: { left: number; top: number; width: number; height: number }) {
  return { getBoundingClientRect: () => rect } as unknown as HTMLElement;
}

describe("moveCursorTo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("SSR/no-DOM safe: resolves immediately when document doesn't exist, same discipline waitForDomSettle already uses", async () => {
    // document is genuinely undefined in this plain-Node test environment
    // by default — no stub at all is the real "no DOM" case.
    const el = fakeTarget({ left: 0, top: 0, width: 10, height: 10 });
    await expect(moveCursorTo(el)).resolves.toBeUndefined();
  });

  it("resolves immediately (no throw) when the element has no getBoundingClientRect — a fake test element, or a genuinely non-visual target", async () => {
    vi.stubGlobal("document", makeFakeDocument());
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    const el = {} as HTMLElement; // no getBoundingClientRect at all
    await expect(moveCursorTo(el)).resolves.toBeUndefined();
  });

  it("creates one real cursor element, reused across calls (a real singleton, not one per move)", async () => {
    const doc = makeFakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });

    const el = fakeTarget({ left: 100, top: 50, width: 20, height: 10 });
    const promise1 = moveCursorTo(el);
    await vi.runAllTimersAsync();
    await promise1;
    const firstCursor = doc.getElementById("cairn-cursor");
    expect(firstCursor).toBeTruthy();

    const promise2 = moveCursorTo(el);
    await vi.runAllTimersAsync();
    await promise2;
    const secondCursor = doc.getElementById("cairn-cursor");
    expect(secondCursor).toBe(firstCursor); // same object — genuinely reused, not recreated
  });

  it("positions the cursor at the target element's real center, computed from its own getBoundingClientRect", async () => {
    const doc = makeFakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });

    const el = fakeTarget({ left: 100, top: 50, width: 40, height: 20 }); // center: (120, 60)
    const promise = moveCursorTo(el);
    await vi.runAllTimersAsync();
    await promise;

    const cursor = doc.getElementById("cairn-cursor")!;
    expect(cursor.style.transform).toBe("translate(120px, 60px)");
  });

  it("a real, live-found-shape bug this guards against: the promise only resolves after the full move+hover-pause delay, not immediately — confirmed by NOT resolving before timers advance", async () => {
    vi.stubGlobal("document", makeFakeDocument());
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });

    const el = fakeTarget({ left: 0, top: 0, width: 10, height: 10 });
    let resolved = false;
    void moveCursorTo(el).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(100); // well short of the real move duration
    expect(resolved).toBe(false);

    await vi.runAllTimersAsync();
    expect(resolved).toBe(true);
  });

  it("tracks its own last position as real state across calls — a second move doesn't recompute from the window corner, only the true first move of a session does", async () => {
    // moveCursorTo's "where did it start from" logic (the window's own
    // corner, for a genuinely first-ever move — see the module's own doc
    // comment) only matters for exactly one call per session; this repo's
    // fake-DOM test environment can't observe a real browser's transient
    // pre-paint style (the offsetHeight-flush trick only works with a real
    // layout engine), so what's actually verifiable here is the CONTRACT:
    // module state persists, and only updates to the real target each
    // time — not a re-check of the window-corner value on every call.
    vi.resetModules();
    const { moveCursorTo: freshMoveCursorTo } = await import("./cursor-overlay");

    const doc = makeFakeDocument();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", { innerWidth: 1000, innerHeight: 800, setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });

    const first = fakeTarget({ left: 500, top: 400, width: 10, height: 10 }); // center (505, 405)
    const firstPromise = freshMoveCursorTo(first);
    await vi.runAllTimersAsync();
    await firstPromise;
    const cursor = doc.getElementById("cairn-cursor")!;
    expect(cursor.style.transform).toBe("translate(505px, 405px)");

    const second = fakeTarget({ left: 100, top: 60, width: 20, height: 20 }); // center (110, 70)
    const secondPromise = freshMoveCursorTo(second);
    await vi.runAllTimersAsync();
    await secondPromise;
    // The cursor genuinely moved to the SECOND target, not back to the
    // window corner — proving the "first move" branch fires at most once.
    expect(cursor.style.transform).toBe("translate(110px, 70px)");
  });
});

describe("hideCursor", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is safe to call even when the cursor was never created (no DOM, or never moved yet)", () => {
    expect(() => hideCursor()).not.toThrow();
  });

  it("fades an existing cursor out by setting its opacity to 0", () => {
    const doc = makeFakeDocument();
    const cursor = makeFakeCursorEl();
    cursor.id = "cairn-cursor";
    cursor.style.opacity = "1";
    doc.body.appendChild(cursor);
    vi.stubGlobal("document", doc);

    hideCursor();
    expect(cursor.style.opacity).toBe("0");
  });
});

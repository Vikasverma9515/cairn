import { afterEach, describe, expect, it, vi } from "vitest";
import { scanInteractiveElements } from "./runtime-scan";

interface FakeRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

function rect(overrides: Partial<FakeRect> = {}): FakeRect {
  // A plain 100x30 box sitting inside the default 1024x768 viewport unless overridden.
  return { top: 100, bottom: 130, left: 100, right: 200, width: 100, height: 30, ...overrides };
}

function fakeButton(label: string, r: FakeRect, attrs: Record<string, string> = {}) {
  return {
    tagName: "BUTTON",
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => r,
    textContent: label,
  } as unknown as HTMLElement;
}

/** Stubs just enough of `document`/`window` for scanInteractiveElements to
 * run in plain Node — same fake-DOM approach verb-executor.test.ts already
 * established (no jsdom in this repo's test environment). */
function withFakeDom<T>(elements: HTMLElement[], fn: () => T): T {
  vi.stubGlobal("document", {
    querySelectorAll: () => elements,
  });
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 });
  try {
    return fn();
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("scanInteractiveElements", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("finds an element that's actually on screen, same as before", () => {
    const btn = fakeButton("Archive", rect());
    const { elements, byId } = withFakeDom([btn], () => scanInteractiveElements());
    expect(elements).toEqual([{ id: "live-0", role: "button", label: "Archive" }]);
    expect(byId.get("live-0")).toBe(btn);
  });

  it("real bug this fixes: an element below the fold is now discoverable, not silently invisible", () => {
    // 2000px down — well past the 768px-tall fake viewport.
    const belowFold = fakeButton("Load more", rect({ top: 2000, bottom: 2030 }));
    const { elements } = withFakeDom([belowFold], () => scanInteractiveElements());
    expect(elements).toEqual([{ id: "live-0", role: "button", label: "Load more" }]);
  });

  it("ranks on-screen elements ahead of off-screen ones when both are present", () => {
    const onScreen = fakeButton("Visible now", rect());
    const offScreen = fakeButton("Scroll to me", rect({ top: 2000, bottom: 2030 }));
    // Off-screen element listed FIRST in the DOM order — ranking, not DOM
    // order, must decide priority.
    const { elements } = withFakeDom([offScreen, onScreen], () => scanInteractiveElements());
    expect(elements.map((e) => e.label)).toEqual(["Visible now", "Scroll to me"]);
  });

  it("ranks a nearer off-screen element ahead of a farther one", () => {
    const justBelow = fakeButton("Just below the fold", rect({ top: 800, bottom: 830 }));
    const farBelow = fakeButton("Three screens down", rect({ top: 3000, bottom: 3030 }));
    const { elements } = withFakeDom([farBelow, justBelow], () => scanInteractiveElements());
    expect(elements.map((e) => e.label)).toEqual(["Just below the fold", "Three screens down"]);
  });

  it("still excludes an element that isn't rendered at all (display:none) — not the same as merely off-screen", () => {
    const hidden = fakeButton("Hidden", rect({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }));
    const visible = fakeButton("Visible", rect());
    const { elements } = withFakeDom([hidden, visible], () => scanInteractiveElements());
    expect(elements).toEqual([{ id: "live-0", role: "button", label: "Visible" }]);
  });

  it("on-screen elements still win every slot when the cap is reached, off-screen ones don't crowd them out", () => {
    const onScreen = Array.from({ length: 50 }, (_, i) => fakeButton(`On-screen ${i}`, rect()));
    const offScreen = fakeButton("Off-screen straggler", rect({ top: 2000, bottom: 2030 }));
    const { elements } = withFakeDom([offScreen, ...onScreen], () => scanInteractiveElements());
    expect(elements).toHaveLength(50);
    expect(elements.every((e) => e.label.startsWith("On-screen"))).toBe(true);
  });
});

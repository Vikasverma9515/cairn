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

/** A minimal `.closest()` for these flat fixtures — real elements have a
 * real ancestor chain to walk, but every fixture here is either the
 * target element itself or a bare stand-in with no real parents, so
 * "does this element ITSELF carry the requested class" is the accurate
 * (if simplified) equivalent for what these tests actually need it for:
 * findOpenDialog's own "is this the Cairn widget's panel (or nested
 * inside it)" exclusion check. */
function fakeClosest(className = "") {
  return (selector: string) => (className.split(/\s+/).includes(selector.replace(/^\./, "")) ? {} : null);
}

function fakeButton(label: string, r: FakeRect, attrs: Record<string, string> = {}, className = "") {
  return {
    tagName: "BUTTON",
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => r,
    textContent: label,
    closest: fakeClosest(className),
  } as unknown as HTMLElement;
}

/** A plain `<div>` with no semantic tag/role/data-ai — only a click handler
 * (real React or plain-JS), the exact shape a CSS selector can never
 * discover on its own. */
function fakeClickableDiv(label: string, r: FakeRect, handler: "onclick" | "react" | "reactEventHandlers" | "none" = "onclick") {
  const el: Record<string, unknown> = {
    tagName: "DIV",
    getAttribute: () => null,
    getBoundingClientRect: () => r,
    textContent: label,
    closest: fakeClosest(),
  };
  if (handler === "onclick") el.onclick = () => {};
  if (handler === "react") el.__reactProps$abc123 = { onClick: () => {} };
  if (handler === "reactEventHandlers") el.__reactEventHandlers$xyz789 = { onClick: () => {} };
  return el as unknown as HTMLElement;
}

function looksSemantic(el: HTMLElement): boolean {
  const withAttr = el as unknown as { getAttribute: (n: string) => string | null };
  if (withAttr.getAttribute("data-ai")) return true;
  if (withAttr.getAttribute("role") === "button") return true;
  return ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Real ARIA markers findOpenDialog's own DIALOG_SELECTOR looks for —
 * mirrored here so the fake querySelectorAll below can discriminate that
 * selector from CANDIDATE_SELECTOR/"*" by what it would ACTUALLY match in
 * a real browser, not just by string identity. */
function looksLikeDialog(el: HTMLElement): boolean {
  const withAttr = el as unknown as { getAttribute: (n: string) => string | null };
  const role = withAttr.getAttribute("role");
  return role === "dialog" || role === "alertdialog" || withAttr.getAttribute("aria-modal") === "true";
}

/**
 * A dialog/modal fixture — adds querySelector (for labelForDialog's
 * heading fallback) and querySelectorAll (so scanInteractiveElements can
 * scope a modal scan to just THIS element's own subtree, the actual
 * feature under test) on top of fakeButton's shape, since a real dialog
 * element supports the full Element API a plain fakeButton fixture
 * doesn't need. `heading` is returned by querySelector("h1, h2, ...")
 * when no aria-label/aria-labelledby is set. `inside` is what a modal
 * scan scoped to this dialog should find — its own querySelectorAll
 * mirrors the top-level stub's own "*" vs CANDIDATE_SELECTOR
 * discrimination, scoped to just this list.
 */
function fakeDialog(r: FakeRect, attrs: Record<string, string> = {}, heading: string | null = null, inside: HTMLElement[] = [], className = "") {
  return {
    tagName: "DIV",
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => r,
    textContent: "",
    querySelector: () => (heading ? ({ textContent: heading } as unknown as HTMLElement) : null),
    querySelectorAll: (selector: string) => (selector === "*" ? inside : inside.filter(looksSemantic)),
    ownerDocument: { getElementById: () => null },
    closest: fakeClosest(className),
  } as unknown as HTMLElement;
}

/** Stubs just enough of `document`/`window` for scanInteractiveElements to
 * run in plain Node — same fake-DOM approach verb-executor.test.ts already
 * established (no jsdom in this repo's test environment). The fake
 * querySelectorAll discriminates the three real selector shapes this
 * module actually issues — "*" (every element, the non-semantic fallback
 * pass), CANDIDATE_SELECTOR (semantically-obvious elements), and
 * DIALOG_SELECTOR (real ARIA dialog markers, via looksLikeDialog) — by
 * what each would ACTUALLY match in a real browser, not by a generic
 * "semantic-ish" heuristic applied to every non-"*" selector. That
 * generic version is what let a plain fakeButton get misidentified as an
 * open dialog once DIALOG_SELECTOR existed — a real, live-found gap in
 * the test double itself, caught by 6 pre-existing tests crashing the
 * moment findOpenDialog started running against them. */
function withFakeDom<T>(elements: HTMLElement[], fn: () => T): T {
  vi.stubGlobal("document", {
    querySelectorAll: (selector: string) => {
      if (selector === "*") return elements;
      if (selector.includes("dialog") || selector.includes("aria-modal")) return elements.filter(looksLikeDialog);
      return elements.filter(looksSemantic);
    },
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

  it("real bug this fixes: a plain <div onClick> with no semantic tag/role is now discoverable, reported as role 'clickable'", () => {
    const div = fakeClickableDiv("View invoice", rect(), "react");
    const { elements, byId } = withFakeDom([div], () => scanInteractiveElements());
    expect(elements).toEqual([{ id: "live-0", role: "clickable", label: "View invoice" }]);
    expect(byId.get("live-0")).toBe(div);
  });

  it("finds a React click handler under both the __reactProps$ and older __reactEventHandlers$ key shapes", () => {
    const modern = fakeClickableDiv("New-style", rect(), "react");
    const legacy = fakeClickableDiv("Old-style", rect(), "reactEventHandlers");
    const { elements } = withFakeDom([modern, legacy], () => scanInteractiveElements());
    expect(elements.map((e) => e.label).sort()).toEqual(["New-style", "Old-style"]);
  });

  it("finds a plain el.onclick handler too, not just React's synthetic prop", () => {
    const div = fakeClickableDiv("Plain JS handler", rect(), "onclick");
    const { elements } = withFakeDom([div], () => scanInteractiveElements());
    expect(elements).toEqual([{ id: "live-0", role: "clickable", label: "Plain JS handler" }]);
  });

  it("ignores a div with no click handler at all — not everything on the page is a candidate", () => {
    const div = fakeClickableDiv("Just some text", rect(), "none");
    const { elements } = withFakeDom([div], () => scanInteractiveElements());
    expect(elements).toEqual([]);
  });

  it("a real <button> is never double-counted through the non-semantic fallback pass", () => {
    const btn = fakeButton("Archive", rect());
    const { elements } = withFakeDom([btn], () => scanInteractiveElements());
    expect(elements).toHaveLength(1);
  });
});

describe("scanInteractiveElements > openDialog detection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports null when nothing on the page has a real dialog ARIA marker", () => {
    const btn = fakeButton("Archive", rect());
    const { openDialog } = withFakeDom([btn], () => scanInteractiveElements());
    expect(openDialog).toBeNull();
  });

  it("a real aria-modal=\"true\" dialog is detected, labeled, and scopes the scan to just its own contents", () => {
    const insideBtn = fakeButton("Confirm delete", rect());
    const dialog = fakeDialog(rect({ top: 200, bottom: 400 }), { role: "dialog", "aria-modal": "true", "aria-label": "Delete this invoice?" }, null, [insideBtn]);
    const backgroundBtn = fakeButton("Archive", rect());

    const { elements, openDialog } = withFakeDom([dialog, backgroundBtn], () => scanInteractiveElements());

    expect(openDialog).toEqual({ label: "Delete this invoice?", modal: true });
    // Background element is genuinely excluded — the whole point of a modal scan.
    expect(elements.map((e) => e.label)).toEqual(["Confirm delete"]);
    expect(elements.some((e) => e.label === "Archive")).toBe(false);
  });

  it("a non-modal role=\"dialog\" (no aria-modal) is reported but does NOT narrow the scan — that content is still really reachable", () => {
    const insideBtn = fakeButton("Dismiss", rect());
    const dialog = fakeDialog(rect(), { role: "dialog", "aria-label": "Notice" }, null, [insideBtn]);
    const backgroundBtn = fakeButton("Archive", rect());

    const { elements, openDialog } = withFakeDom([dialog, backgroundBtn], () => scanInteractiveElements());

    expect(openDialog).toEqual({ label: "Notice", modal: false });
    // Background element is still reachable — a non-modal dialog doesn't block the page.
    expect(elements.map((e) => e.label)).toContain("Archive");
  });

  it("label priority: aria-label wins over a heading when both are present", () => {
    const dialog = fakeDialog(rect(), { role: "dialog", "aria-modal": "true", "aria-label": "Explicit label" }, "Heading text");
    const { openDialog } = withFakeDom([dialog], () => scanInteractiveElements());
    expect(openDialog?.label).toBe("Explicit label");
  });

  it("label priority: falls back to the dialog's own first heading when no aria-label is set", () => {
    const dialog = fakeDialog(rect(), { role: "dialog", "aria-modal": "true" }, "Delete this invoice?");
    const { openDialog } = withFakeDom([dialog], () => scanInteractiveElements());
    expect(openDialog?.label).toBe("Delete this invoice?");
  });

  it("label priority: falls back to the plain string \"Dialog\" when nothing else identifies it", () => {
    const dialog = fakeDialog(rect(), { role: "dialog", "aria-modal": "true" }, null);
    const { openDialog } = withFakeDom([dialog], () => scanInteractiveElements());
    expect(openDialog?.label).toBe("Dialog");
  });

  it("a plain button with no dialog ARIA attributes is never misidentified as a dialog", () => {
    // The real bug the fake querySelectorAll stub itself used to have:
    // any non-"*" selector fell through to the same generic "semantic-
    // ish" filter, so a plain <button> looked like a DIALOG_SELECTOR
    // match too. Direct regression test for that.
    const btn = fakeButton("Archive", rect());
    const { openDialog } = withFakeDom([btn], () => scanInteractiveElements());
    expect(openDialog).toBeNull();
  });

  it("real bug caught live: the Cairn widget's OWN panel (role=\"dialog\" for its own accessibility) is never treated as the detected dialog", () => {
    // Live-verified against the real demo app: .cairn-panel carries
    // role="dialog" (correct a11y for a floating chat panel), and since
    // the widget is open almost the entire time a user is talking to it,
    // an unfiltered scan picked the WIDGET's own panel as "the open
    // dialog" (last in DOM order) instead of — or on top of — a real
    // host-app modal open at the same time. This is the direct
    // regression test for that fix.
    const widgetPanel = fakeDialog(rect(), { role: "dialog" }, null, [], "cairn-panel");
    const { openDialog } = withFakeDom([widgetPanel], () => scanInteractiveElements());
    expect(openDialog).toBeNull();
  });

  it("a real host-app dialog is still detected correctly even while the Cairn widget panel is open at the same time", () => {
    const insideBtn = fakeButton("Confirm delete", rect());
    const hostDialog = fakeDialog(rect(), { role: "dialog", "aria-modal": "true", "aria-label": "Delete this invoice?" }, null, [insideBtn]);
    const widgetPanel = fakeDialog(rect(), { role: "dialog" }, null, [], "cairn-panel");
    // Widget panel listed AFTER the host dialog in DOM order — exactly
    // the real-world case (the widget typically mounts late in <body>) —
    // to prove the exclusion isn't just accidentally working via
    // ordering.
    const { openDialog } = withFakeDom([hostDialog, widgetPanel], () => scanInteractiveElements());
    expect(openDialog).toEqual({ label: "Delete this invoice?", modal: true });
  });
});

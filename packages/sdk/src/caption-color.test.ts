import { afterEach, describe, expect, it, vi } from "vitest";
import { pickReadableCaptionColor, relativeLuminance, sampleAncestorBackgroundColor } from "./index";

// This test file runs under vitest's default (node) environment — same
// reasoning as conversation-persistence.test.ts's own header comment: these
// are plain functions, not components, so no DOM/jsdom is needed except
// where sampleAncestorBackgroundColor's own tests stub just enough of it.

describe("relativeLuminance", () => {
  it("real reference values — pure black is 0, pure white is 1", () => {
    expect(relativeLuminance(0, 0, 0)).toBeCloseTo(0, 5);
    expect(relativeLuminance(255, 255, 255)).toBeCloseTo(1, 5);
  });

  it("weights green highest and blue lowest — real perceptual math, not a flat (r+g+b)/3 average", () => {
    const green = relativeLuminance(0, 255, 0);
    const red = relativeLuminance(255, 0, 0);
    const blue = relativeLuminance(0, 0, 255);
    expect(green).toBeGreaterThan(red);
    expect(red).toBeGreaterThan(blue);
  });
});

describe("pickReadableCaptionColor", () => {
  it("white text on a real dark background", () => {
    expect(pickReadableCaptionColor(10, 12, 18)).toBe("#ffffff"); // this widget's own near-black FAB color
    expect(pickReadableCaptionColor(0, 0, 0)).toBe("#ffffff");
  });

  it("near-black text on a real light background", () => {
    expect(pickReadableCaptionColor(255, 255, 255)).toBe("#0a0b0e");
    expect(pickReadableCaptionColor(240, 240, 245)).toBe("#0a0b0e");
  });

  it("flips the right way on a real mid-tone brand color, not just pure black/white — the actual case this exists for", () => {
    // A real, common SaaS brand blue (Tailwind's own blue-600) — dark enough
    // that white reads correctly, the exact case a naive (r+g+b)/3 average
    // sometimes gets wrong for saturated blues.
    expect(pickReadableCaptionColor(37, 99, 235)).toBe("#ffffff");
  });
});

describe("sampleAncestorBackgroundColor", () => {
  // A hand-rolled fake Element chain — real getComputedStyle needs a real
  // DOM, which this repo's own default (node) test environment doesn't
  // have; verb-executor.test.ts/element-ladder.test.ts already established
  // this exact stubGlobal pattern for the same reason.
  function fakeElement(backgroundColor: string, parent: unknown = null): Element {
    const el = { parentElement: parent } as unknown as Element;
    stubbedStyles.set(el, backgroundColor);
    return el;
  }
  const stubbedStyles = new Map<Element, string>();

  afterEach(() => {
    stubbedStyles.clear();
    vi.unstubAllGlobals();
  });

  function stubDocumentAndComputedStyle() {
    vi.stubGlobal("document", { documentElement: {} });
    vi.stubGlobal("getComputedStyle", (el: Element) => ({
      backgroundColor: stubbedStyles.get(el) ?? "rgba(0, 0, 0, 0)",
    }));
  }

  it("finds the first real, opaque ancestor color — skipping fully transparent layers above it", () => {
    stubDocumentAndComputedStyle();
    const pageRoot = fakeElement("rgb(20, 21, 27)");
    const transparentWrapper = fakeElement("rgba(0, 0, 0, 0)", pageRoot);
    const captionParent = fakeElement("rgba(0, 0, 0, 0)", transparentWrapper);

    const result = sampleAncestorBackgroundColor(captionParent);
    expect(result).toEqual({ r: 20, g: 21, b: 27 });
  });

  it("skips a mostly-transparent layer (alpha <= 0.5) — that's not what a viewer's eye actually perceives as the background", () => {
    stubDocumentAndComputedStyle();
    const realBg = fakeElement("rgb(255, 255, 255)");
    const fadedOverlay = fakeElement("rgba(0, 0, 0, 0.3)", realBg);

    expect(sampleAncestorBackgroundColor(fadedOverlay)).toEqual({ r: 255, g: 255, b: 255 });
  });

  it("returns null when nothing in the chain has a real declared color — an image/gradient/video background, honestly reported as unknown rather than guessed at", () => {
    stubDocumentAndComputedStyle();
    const allTransparent = fakeElement("rgba(0, 0, 0, 0)");
    expect(sampleAncestorBackgroundColor(allTransparent)).toBeNull();
  });

  it("returns null for a null start element — never throws", () => {
    stubDocumentAndComputedStyle();
    expect(sampleAncestorBackgroundColor(null)).toBeNull();
  });
});

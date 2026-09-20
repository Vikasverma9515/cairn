import { describe, expect, it } from "vitest";
import { isDarkColor, parseCssColor } from "./theme";

describe("parseCssColor", () => {
  it("reads computed rgb and rgba values", () => {
    expect(parseCssColor("rgb(9, 9, 15)")).toEqual({ r: 9, g: 9, b: 15, a: 1 });
    expect(parseCssColor("rgba(255, 255, 255, 0.5)")).toEqual({ r: 255, g: 255, b: 255, a: 0.5 });
    expect(parseCssColor("rgba(0, 0, 0, 0)")?.a).toBe(0);
  });
  it("returns null for things it cannot parse", () => {
    expect(parseCssColor("transparent")).toBeNull();
    expect(parseCssColor(undefined)).toBeNull();
  });
});

describe("isDarkColor", () => {
  it("calls Neha's near-black background dark and a white page light", () => {
    expect(isDarkColor({ r: 9, g: 9, b: 15 })).toBe(true);
    expect(isDarkColor({ r: 255, g: 255, b: 255 })).toBe(false);
    expect(isDarkColor({ r: 245, g: 245, b: 247 })).toBe(false);
  });
});

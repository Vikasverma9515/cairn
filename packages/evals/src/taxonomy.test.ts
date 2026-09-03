import { describe, expect, it } from "vitest";
import { CAPABILITY_TAGS, CAPABILITY_DESCRIPTIONS, isCapabilityTag } from "./taxonomy";
import { scenarios } from "./scenarios/index";

describe("taxonomy", () => {
  it("every capability tag has a real description, not a placeholder", () => {
    for (const tag of CAPABILITY_TAGS) {
      expect(CAPABILITY_DESCRIPTIONS[tag]).toBeTruthy();
      expect(CAPABILITY_DESCRIPTIONS[tag].length).toBeGreaterThan(10);
    }
  });

  it("isCapabilityTag correctly distinguishes real tags from invented ones", () => {
    expect(isCapabilityTag("content-ops")).toBe(true);
    expect(isCapabilityTag("made-up-capability")).toBe(false);
  });
});

describe("scenarios/index — capability tagging", () => {
  it("every scenario declares at least one real capability tag", () => {
    for (const scenario of scenarios) {
      expect(scenario.capabilities.length).toBeGreaterThan(0);
      for (const tag of scenario.capabilities) {
        expect(isCapabilityTag(tag)).toBe(true);
      }
    }
  });

  it("real gap this surfaces honestly: several capability dimensions have zero scenario coverage today", () => {
    const covered = new Set(scenarios.flatMap((s) => s.capabilities));
    const uncovered = CAPABILITY_TAGS.filter((t) => !covered.has(t));
    // Not asserting this is empty - it's a known, honest gap (see the eval
    // plan's build order: new primitives/scenarios land in later steps).
    // This test exists so the gap is visible and tracked, not silently
    // forgotten - update the expected list as scenarios are added.
    // "policy-constraint" was closed by step 6b's complete-shop-checkout
    // scenario (a real server-side 403 gate, not a UI-only appearance).
    // "ambiguous-clarify" was closed by step 7's simulated-user scenario
    // (archive-invoices-with-approval-threshold) - a real clarifying
    // question is the correct move there, not a guess.
    expect(uncovered.sort()).toEqual(["error-recovery", "navigation", "non-semantic-ui", "unachievable"].sort());
  });
});

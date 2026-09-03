import { describe, expect, it } from "vitest";
import { capabilitiesOf, GENRES, PRIMITIVES } from "./index";
import { isCapabilityTag } from "../taxonomy";

describe("PRIMITIVES", () => {
  it("every primitive declares at least one real capability tag", () => {
    for (const primitive of Object.values(PRIMITIVES)) {
      expect(primitive.capabilities.length).toBeGreaterThan(0);
      for (const tag of primitive.capabilities) expect(isCapabilityTag(tag)).toBe(true);
    }
  });

  it("every primitive's id key matches its own declared id", () => {
    for (const [key, primitive] of Object.entries(PRIMITIVES)) {
      expect(primitive.id).toBe(key);
    }
  });
});

describe("GENRES", () => {
  it("every genre only references primitives that actually exist", () => {
    for (const genre of Object.values(GENRES)) {
      for (const primitiveId of genre.primitives) {
        expect(PRIMITIVES[primitiveId]).toBeDefined();
      }
    }
  });

  it("every genre's id key matches its own declared id", () => {
    for (const [key, genre] of Object.entries(GENRES)) {
      expect(genre.id).toBe(key);
    }
  });
});

describe("capabilitiesOf", () => {
  it("dedupes capability tags across a genre's composed primitives", () => {
    // Both workflow-builder's primitives (canvas, state-machine) share
    // "multi-step-composite"/"content-ops" split across them, not
    // duplicated - a real check that composition doesn't silently
    // double-count or drop tags.
    const tags = capabilitiesOf("workflow-builder");
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags).toContain("multi-step-composite");
    expect(tags).toContain("content-ops");
  });

  it("a single-primitive genre reports exactly that primitive's capabilities", () => {
    expect(capabilitiesOf("crud-dashboard")).toEqual(["content-ops"]);
  });
});

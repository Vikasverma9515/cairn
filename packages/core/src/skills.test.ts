import { describe, expect, it } from "vitest";
import { SkillSchema, slugifySkillId } from "./skills";

describe("slugifySkillId", () => {
  it("lowercases and hyphenates a real name", () => {
    expect(slugifySkillId("Connecting nodes on the workflow canvas")).toBe("connecting-nodes-on-the-workflow-canvas");
  });

  it("collapses runs of non-alphanumeric characters into a single hyphen", () => {
    expect(slugifySkillId("Search & Filter --- Products!!")).toBe("search-filter-products");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugifySkillId("  !!!Archive Invoice!!!  ")).toBe("archive-invoice");
  });

  it("falls back to a real, non-empty id for a name with nothing alphanumeric in it", () => {
    expect(slugifySkillId("!!!")).toBe("skill");
    expect(slugifySkillId("")).toBe("skill");
  });
});

describe("SkillSchema", () => {
  it("accepts a real, fully-specified Skill", () => {
    const parsed = SkillSchema.safeParse({
      id: "connect-nodes",
      name: "Connecting nodes on the workflow canvas",
      description: "Uses a dropdown, not drag.",
      instructions: "The canvas connects nodes via a dropdown labeled 'connects to'.",
      pattern: "canvas",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("pattern is genuinely optional — a Skill from an unclassified page still parses", () => {
    const parsed = SkillSchema.safeParse({
      id: "x",
      name: "x",
      description: "x",
      instructions: "x",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a Skill missing real required fields", () => {
    expect(SkillSchema.safeParse({ id: "x", name: "x" }).success).toBe(false);
  });
});

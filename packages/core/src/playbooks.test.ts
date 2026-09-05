import { describe, expect, it } from "vitest";
import { PLAYBOOKS, renderPlaybookHint } from "./playbooks";
import { UI_PATTERNS } from "./ui-patterns";

describe("PLAYBOOKS", () => {
  it("has a real, non-empty playbook for every UI pattern — never a gap the Planner could silently fall through", () => {
    for (const pattern of UI_PATTERNS) {
      expect(PLAYBOOKS[pattern]).toBeDefined();
      expect(PLAYBOOKS[pattern].length).toBeGreaterThan(0);
      for (const step of PLAYBOOKS[pattern]) {
        expect(step.length).toBeGreaterThan(0);
      }
    }
  });

  it("canvas's playbook explicitly tells the model to check select vs. drag before choosing — the real, concrete ambiguity this platform's own connection mechanism can have", () => {
    expect(PLAYBOOKS.canvas.join(" ")).toContain("select");
    expect(PLAYBOOKS.canvas.join(" ")).toContain("drag");
  });
});

describe("renderPlaybookHint", () => {
  it("joins a pattern's steps into one real, non-empty string", () => {
    const hint = renderPlaybookHint("table-crud");
    expect(hint.length).toBeGreaterThan(0);
    for (const step of PLAYBOOKS["table-crud"]) {
      expect(hint).toContain(step);
    }
  });
});

import { describe, expect, it } from "vitest";
import { classifyUiPattern, deriveStructureSignals, UI_PATTERNS } from "./ui-patterns";

describe("deriveStructureSignals", () => {
  it("counts roles and lowercases labels from real liveElements", () => {
    const signals = deriveStructureSignals([
      { role: "button", label: "Archive" },
      { role: "button", label: "ARCHIVE" },
      { role: "input", label: "Search products" },
    ]);
    expect(signals.roleCounts).toEqual({ button: 2, input: 1 });
    expect(signals.labels).toEqual(["archive", "archive", "search products"]);
    expect(signals.totalElements).toBe(3);
  });

  it("handles an empty page honestly — no roles, no labels, zero total", () => {
    const signals = deriveStructureSignals([]);
    expect(signals.roleCounts).toEqual({});
    expect(signals.labels).toEqual([]);
    expect(signals.totalElements).toBe(0);
  });
});

describe("classifyUiPattern", () => {
  it("real fixture: examples/demo-app's /workflows page (node canvas, connected via a 'connects to' select) classifies as canvas", () => {
    const signals = deriveStructureSignals([
      { role: "button", label: "+ Webhook trigger" },
      { role: "button", label: "+ Send email" },
      { role: "input", label: "Webhook trigger Form name" },
      { role: "select", label: "Webhook trigger connects to" },
      { role: "button", label: "Run test" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).toContain("canvas");
    const canvasMatch = matches.find((m) => m.pattern === "canvas")!;
    expect(canvasMatch.reasoning).toContain("connect");
  });

  it("real fixture: examples/demo-app's /invoices page (repeated per-row archive buttons, no form fields) classifies as table-crud", () => {
    const signals = deriveStructureSignals([
      { role: "button", label: "Archive" },
      { role: "button", label: "Archive" },
      { role: "button", label: "New Invoice" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).toContain("table-crud");
  });

  it("a table-crud match requires the repeated action AND no form fields — a page with both repeated archive buttons and real inputs doesn't get misclassified as a bare table", () => {
    const signals = deriveStructureSignals([
      { role: "button", label: "Archive" },
      { role: "button", label: "Archive" },
      { role: "input", label: "Client name" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).not.toContain("table-crud");
  });

  it("real fixture: examples/demo-app's /board page (kanban) classifies as kanban", () => {
    const signals = deriveStructureSignals([
      { role: "clickable", label: "To Do column" },
      { role: "clickable", label: "Move to In Progress" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).toContain("kanban");
  });

  it("real fixture: examples/demo-app's /shop page (search/filter) classifies as search-filter", () => {
    const signals = deriveStructureSignals([
      { role: "input", label: "Search products" },
      { role: "button", label: "Go" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).toContain("search-filter");
  });

  it("real fixture: examples/demo-app's checkout wizard classifies as wizard", () => {
    const signals = deriveStructureSignals([
      { role: "input", label: "Full name" },
      { role: "button", label: "Continue to shipping" },
    ]);
    const matches = classifyUiPattern(signals);
    expect(matches.map((m) => m.pattern)).toContain("wizard");
  });

  it("a page matching none of the known patterns returns an empty list — never forces a wrong guess", () => {
    const signals = deriveStructureSignals([{ role: "a", label: "About us" }]);
    expect(classifyUiPattern(signals)).toEqual([]);
  });

  it("every returned match's pattern is a real member of UI_PATTERNS", () => {
    const signals = deriveStructureSignals([
      { role: "button", label: "Archive" },
      { role: "button", label: "Archive" },
      { role: "select", label: "Connects to" },
    ]);
    for (const match of classifyUiPattern(signals)) {
      expect(UI_PATTERNS).toContain(match.pattern);
    }
  });
});

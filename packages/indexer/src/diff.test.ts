import { describe, expect, it } from "vitest";
import type { Manifest } from "@cairn/core";
import { diffManifests, formatDiffAsText } from "./diff";

function page(overrides: Partial<Manifest["pages"][number]> = {}): Manifest["pages"][number] {
  return {
    id: "invoices-list",
    route: "/invoices",
    file: "app/invoices/page.tsx",
    title: "Invoices",
    purpose: "Shows every invoice.",
    whenToUse: "Check payment status.",
    confidence: 0.9,
    elements: [
      {
        id: "create-invoice",
        label: "New Invoice",
        selector: "[data-ai='create-invoice']",
        fallbacks: [],
        does: "Opens a form to bill a customer.",
        confidence: 0.9,
        evidence: [],
      },
    ],
    ...overrides,
  };
}

function manifest(pages: Manifest["pages"], dead: string[] = []): Manifest {
  return { version: "1", commit: "x", generatedAt: new Date().toISOString(), pages, dead, conflicts: [] };
}

describe("diffManifests", () => {
  it("detects an added page", () => {
    const before = manifest([]);
    const after = manifest([page()]);
    const diff = diffManifests(before, after);
    expect(diff.pagesAdded).toEqual(["/invoices"]);
    expect(diff.pagesRemoved).toEqual([]);
  });

  it("detects a removed page", () => {
    const before = manifest([page()]);
    const after = manifest([]);
    const diff = diffManifests(before, after);
    expect(diff.pagesRemoved).toEqual(["/invoices"]);
  });

  it("detects an added element on an unchanged page", () => {
    const before = manifest([page()]);
    const after = manifest([
      page({
        elements: [
          ...page().elements,
          {
            id: "archive-invoice",
            label: "Archive",
            selector: "[data-ai='archive-invoice']",
            fallbacks: [],
            does: "Archives the invoice.",
            confidence: 0.8,
            evidence: [],
          },
        ],
      }),
    ]);
    const diff = diffManifests(before, after);
    expect(diff.pagesChanged).toHaveLength(1);
    expect(diff.pagesChanged[0].elementsAdded).toEqual(["archive-invoice"]);
  });

  it("detects a changed element description/confidence", () => {
    const before = manifest([page()]);
    const after = manifest([
      page({
        elements: [{ ...page().elements[0], does: "Opens a longer, more specific form.", confidence: 0.95 }],
      }),
    ]);
    const diff = diffManifests(before, after);
    expect(diff.pagesChanged[0].elementsChanged).toEqual([
      {
        id: "create-invoice",
        doesBefore: "Opens a form to bill a customer.",
        doesAfter: "Opens a longer, more specific form.",
        confidenceBefore: 0.9,
        confidenceAfter: 0.95,
      },
    ]);
  });

  it("reports no page change when nothing actually changed", () => {
    const before = manifest([page()]);
    const after = manifest([page()]);
    expect(diffManifests(before, after).pagesChanged).toEqual([]);
  });

  it("tracks dead-file additions and removals", () => {
    const before = manifest([], ["components/Old.tsx"]);
    const after = manifest([], ["components/EvenOlder.tsx"]);
    const diff = diffManifests(before, after);
    expect(diff.deadAdded).toEqual(["components/EvenOlder.tsx"]);
    expect(diff.deadRemoved).toEqual(["components/Old.tsx"]);
  });
});

describe("formatDiffAsText", () => {
  it("reports 'no changes' for an empty diff", () => {
    expect(formatDiffAsText(diffManifests(manifest([page()]), manifest([page()])))).toBe("no changes");
  });

  it("renders a human-readable summary for a real diff", () => {
    const text = formatDiffAsText(diffManifests(manifest([]), manifest([page()])));
    expect(text).toContain("pages added: /invoices");
  });
});

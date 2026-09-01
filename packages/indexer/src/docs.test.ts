import { describe, expect, it } from "vitest";
import type { Manifest } from "@cairnvibe/core";
import { generateDocsMarkdown } from "./docs";

const manifest: Manifest = {
  version: "1",
  commit: "abc123",
  generatedAt: "2026-01-01T00:00:00.000Z",
  pages: [
    {
      id: "invoices-list",
      route: "/invoices",
      file: "app/invoices/page.tsx",
      title: "Invoices",
      purpose: "Shows every invoice you've sent, with status and amount.",
      whenToUse: "Come here to check if a client has paid.",
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
    },
  ],
  dead: ["components/OldInvoiceForm.tsx"],
  conflicts: [
    {
      candidates: ["InvoiceForm.tsx", "InvoiceFormV2.tsx"],
      chose: "InvoiceFormV2.tsx",
      reason: "reachable from router; other has zero inbound imports",
      confidence: 0.8,
    },
  ],
};

describe("generateDocsMarkdown", () => {
  it("includes each page's title, route, purpose, and when-to-use", () => {
    const md = generateDocsMarkdown(manifest);
    expect(md).toContain("## Invoices (`/invoices`)");
    expect(md).toContain("Shows every invoice you've sent, with status and amount.");
    expect(md).toContain("Come here to check if a client has paid.");
  });

  it("lists each element and what it does", () => {
    const md = generateDocsMarkdown(manifest);
    expect(md).toContain("New Invoice");
    expect(md).toContain("Opens a form to bill a customer.");
  });

  it("lists dead files", () => {
    expect(generateDocsMarkdown(manifest)).toContain("components/OldInvoiceForm.tsx");
  });

  it("lists resolved conflicts with their reason", () => {
    const md = generateDocsMarkdown(manifest);
    expect(md).toContain("InvoiceFormV2.tsx");
    expect(md).toContain("reachable from router; other has zero inbound imports");
  });

  it("omits the dead-code section entirely when there's none", () => {
    const md = generateDocsMarkdown({ ...manifest, dead: [] });
    expect(md).not.toContain("## Dead code");
  });
});

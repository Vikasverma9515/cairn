import { describe, expect, it } from "vitest";
import type { Manifest } from "@cairnvibe/core";
import { generateWebMcpComponent } from "./webmcp";

function manifestWith(pages: Manifest["pages"]): Manifest {
  return {
    version: "1",
    commit: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    pages,
    dead: [],
    conflicts: [],
  };
}

describe("generateWebMcpComponent", () => {
  it("returns null when the manifest has no apiCall-backed elements — nothing safe to register", () => {
    const manifest = manifestWith([
      {
        id: "invoices-list",
        route: "/invoices",
        file: "app/invoices/page.tsx",
        title: "Invoices",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          { id: "create-invoice", label: "New Invoice", selector: "x", fallbacks: [], does: "Opens a form.", confidence: 0.9, evidence: [] },
        ],
      },
    ]);
    expect(generateWebMcpComponent(manifest)).toBeNull();
  });

  it("registers a real tool for each apiCall-backed element, named with its page for disambiguation", () => {
    const manifest = manifestWith([
      {
        id: "invoices-list",
        route: "/invoices",
        file: "app/invoices/page.tsx",
        title: "Invoices",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          {
            id: "archive-invoice",
            label: "Archive",
            selector: "x",
            fallbacks: [],
            does: "Archives this invoice.",
            confidence: 0.9,
            evidence: [],
            apiCall: { method: "POST", url: "/api/invoices/archive" },
          },
          { id: "create-invoice", label: "New Invoice", selector: "x", fallbacks: [], does: "Opens a form.", confidence: 0.9, evidence: [] },
        ],
      },
    ]);
    const code = generateWebMcpComponent(manifest);
    expect(code).not.toBeNull();
    expect(code).toContain('"invoices-archive-invoice"');
    expect(code).toContain("Archives this invoice.");
    expect(code).toContain('fetch("/api/invoices/archive", { method: "POST", credentials: "same-origin" })');
    // The non-apiCall element never gets registered.
    expect(code).not.toContain("create-invoice");
  });

  it("is a real, self-contained component — 'use client', a named export, registerTool checked before use, no Cairn import", () => {
    const manifest = manifestWith([
      {
        id: "invoices-list",
        route: "/invoices",
        file: "app/invoices/page.tsx",
        title: "Invoices",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          {
            id: "archive-invoice",
            label: "Archive",
            selector: "x",
            fallbacks: [],
            does: "Archives this invoice.",
            confidence: 0.9,
            evidence: [],
            apiCall: { method: "POST", url: "/api/invoices/archive" },
          },
        ],
      },
    ]);
    const code = generateWebMcpComponent(manifest)!;
    expect(code).toContain('"use client";');
    expect(code).toContain("export function CairnWebMcpTools()");
    expect(code).toContain("modelContext?.registerTool");
    expect(code).not.toContain("@cairnvibe");
  });

  it("dedupes a framework-level element appearing on every page's own elements array into ONE registration, not one per page", () => {
    const globalNavAction = {
      id: "sign-out",
      label: "Sign out",
      selector: "x",
      fallbacks: [],
      does: "Signs the user out.",
      confidence: 0.9,
      evidence: [],
      apiCall: { method: "POST" as const, url: "/api/auth/signout" },
    };
    const manifest = manifestWith([
      { id: "a", route: "/invoices", file: "app/invoices/page.tsx", title: "Invoices", purpose: "p", whenToUse: "w", confidence: 0.9, elements: [globalNavAction] },
      { id: "b", route: "/agents", file: "app/agents/page.tsx", title: "Agents", purpose: "p", whenToUse: "w", confidence: 0.9, elements: [globalNavAction] },
    ]);
    const code = generateWebMcpComponent(manifest)!;
    // Only ONE registration for the shared element, not two.
    expect(code.match(/\/api\/auth\/signout/g)).toHaveLength(1);
  });

  it("disambiguates the same element id on two different pages by route prefix, instead of colliding", () => {
    const manifest = manifestWith([
      {
        id: "a",
        route: "/invoices",
        file: "app/invoices/page.tsx",
        title: "Invoices",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          { id: "archive", label: "Archive", selector: "x", fallbacks: [], does: "Archives this invoice.", confidence: 0.9, evidence: [], apiCall: { method: "POST", url: "/api/invoices/archive" } },
        ],
      },
      {
        id: "b",
        route: "/agents",
        file: "app/agents/page.tsx",
        title: "Agents",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          { id: "archive", label: "Archive", selector: "x", fallbacks: [], does: "Archives this agent.", confidence: 0.9, evidence: [], apiCall: { method: "POST", url: "/api/agents/archive" } },
        ],
      },
    ]);
    const code = generateWebMcpComponent(manifest)!;
    expect(code).toContain('"invoices-archive"');
    expect(code).toContain('"agents-archive"');
  });

  it("slugifies the root route to 'home' instead of leaving an empty/invalid prefix", () => {
    const manifest = manifestWith([
      {
        id: "a",
        route: "/",
        file: "app/page.tsx",
        title: "Home",
        purpose: "p",
        whenToUse: "w",
        confidence: 0.9,
        elements: [
          { id: "subscribe", label: "Subscribe", selector: "x", fallbacks: [], does: "Subscribes to updates.", confidence: 0.9, evidence: [], apiCall: { method: "POST", url: "/api/subscribe" } },
        ],
      },
    ]);
    const code = generateWebMcpComponent(manifest)!;
    expect(code).toContain('"home-subscribe"');
  });
});

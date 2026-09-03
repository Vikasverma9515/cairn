import { describe, expect, it } from "vitest";
import { assembleManifest, parseApiCall } from "./manifest";
import type { RawFacts } from "./types";
import type { L2Result } from "./l2-reachability";
import type { L3Result } from "./l3-describe";

describe("parseApiCall", () => {
  it("accepts a clean, static, mutating call", () => {
    expect(parseApiCall("POST /api/items/archive")).toEqual({ method: "POST", url: "/api/items/archive" });
    expect(parseApiCall("DELETE /api/items")).toEqual({ method: "DELETE", url: "/api/items" });
  });

  it("rejects GET — read-only calls aren't do-verb material", () => {
    expect(parseApiCall("GET /api/items")).toBeNull();
  });

  it("rejects a navigate-shaped handlerCall (a Link, not an action)", () => {
    expect(parseApiCall("navigate /contact")).toBeNull();
  });

  it("rejects null/empty input", () => {
    expect(parseApiCall(null)).toBeNull();
    expect(parseApiCall("")).toBeNull();
  });

  it("rejects a template literal's raw source text — l1-scan.ts's fallback for a per-row URL it can't statically resolve", () => {
    // A real per-row action written as fetch(`/api/items/${id}/archive`, {method:"POST"})
    // — l1-scan.ts can't evaluate the template at build time, so it falls
    // back to the literal source text, backticks and ${...} hole included.
    // That's not a real fetchable URL, and guessing at resolving it risks
    // firing a request at the wrong (or a broken) endpoint.
    expect(parseApiCall("POST `/api/items/${id}/archive`")).toBeNull();
  });

  it("rejects a bare identifier — a URL held in a variable l1-scan.ts can't resolve", () => {
    expect(parseApiCall("POST apiUrl")).toBeNull();
  });

  it("rejects an absolute/cross-origin URL", () => {
    expect(parseApiCall("POST https://evil.example.com/steal")).toBeNull();
  });

  it("rejects a url with no leading slash", () => {
    expect(parseApiCall("POST api/items")).toBeNull();
  });
});

describe("assembleManifest", () => {
  it("passes a page's L1 dataShapes straight through onto the manifest Page, unchanged", () => {
    const facts: RawFacts = {
      version: "1",
      pages: [
        {
          route: "/invoices",
          file: "app/invoices/page.tsx",
          reachableFiles: [],
          elements: [],
          dataShapes: [
            {
              name: "Invoice",
              source: "lib/invoices.ts",
              fields: [{ name: "status", type: '"Paid" | "Overdue" | "Archived"', optional: false }],
            },
          ],
        },
      ],
      allScannedFiles: [],
      frameworkReachableFiles: [],
      frameworkElements: [],
    };
    const l2: L2Result = { dead: [], conflicts: [] };
    const l3: L3Result = { descriptions: new Map(), globalElements: [], cacheHits: 0, cacheMisses: 0 };

    const manifest = assembleManifest("/repo", facts, l2, l3);

    expect(manifest.pages[0].dataShapes).toEqual(facts.pages[0].dataShapes);
  });

  it("passes through an empty dataShapes array as-is", () => {
    const facts: RawFacts = {
      version: "1",
      pages: [{ route: "/", file: "app/page.tsx", reachableFiles: [], elements: [], dataShapes: [] }],
      allScannedFiles: [],
      frameworkReachableFiles: [],
      frameworkElements: [],
    };
    const l2: L2Result = { dead: [], conflicts: [] };
    const l3: L3Result = { descriptions: new Map(), globalElements: [], cacheHits: 0, cacheMisses: 0 };

    const manifest = assembleManifest("/repo", facts, l2, l3);

    expect(manifest.pages[0].dataShapes).toEqual([]);
  });
});

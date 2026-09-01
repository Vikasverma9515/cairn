import { describe, expect, it } from "vitest";
import { parseApiCall } from "./manifest";

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

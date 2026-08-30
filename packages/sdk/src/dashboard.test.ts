import { describe, expect, it } from "vitest";
import { createMissesHandler, createMissesStore, summarizeMisses } from "./dashboard";

describe("createMissesHandler", () => {
  it("400s on an invalid report", async () => {
    const handler = createMissesHandler(createMissesStore());
    const result = await handler.post({ attempted: "create-invoice" }); // missing route
    expect(result.status).toBe(400);
  });

  it("records a valid report and reflects it in the summary", async () => {
    const store = createMissesStore();
    const handler = createMissesHandler(store);

    await handler.post({ attempted: "create-invoice", route: "/invoices" });
    await handler.post({ attempted: "create-invoice", route: "/invoices" });
    await handler.post({ attempted: "archive-invoice", route: "/invoices" });

    const result = await handler.get();
    expect(result.status).toBe(200);
    expect(result.body).toEqual([
      { attempted: "create-invoice", route: "/invoices", count: 2, lastSeen: expect.any(String) },
      { attempted: "archive-invoice", route: "/invoices", count: 1, lastSeen: expect.any(String) },
    ]);
  });
});

describe("summarizeMisses", () => {
  it("groups by route+attempted and sorts most-frequent first", () => {
    const summary = summarizeMisses([
      { attempted: "x", route: "/a", at: "2026-01-01T00:00:00.000Z" },
      { attempted: "y", route: "/a", at: "2026-01-01T00:00:00.000Z" },
      { attempted: "y", route: "/a", at: "2026-01-02T00:00:00.000Z" },
    ]);
    expect(summary[0]).toMatchObject({ attempted: "y", route: "/a", count: 2 });
    expect(summary[1]).toMatchObject({ attempted: "x", route: "/a", count: 1 });
  });
});

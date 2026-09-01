import { describe, expect, it, vi } from "vitest";
import { executeVerbResponse } from "./verb-executor";

function makeOptions() {
  return {
    onExplain: vi.fn(),
    onNavigate: vi.fn(),
    onDo: vi.fn(),
    onMiss: vi.fn(),
    onTour: vi.fn(),
  };
}

describe("executeVerbResponse", () => {
  it("explain: forwards the text", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "explain", text: "This page lists your invoices." }, "/invoices", opts);
    expect(opts.onExplain).toHaveBeenCalledWith("This page lists your invoices.");
  });

  it("navigate: calls onNavigate with the route", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "navigate", route: "/invoices" }, "/", opts);
    expect(opts.onNavigate).toHaveBeenCalledWith("/invoices");
  });

  it("do: executes only when the action is in the caller's registered allowlist", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "do", action: "archiveInvoice" }, "/invoices", {
      ...opts,
      registeredActions: ["archiveInvoice"],
    });
    expect(opts.onDo).toHaveBeenCalledWith("archiveInvoice", undefined);
  });

  it("do: passes the target through so the customer's handler knows what it applies to", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "do", action: "archiveInvoice", target: "inv-2" }, "/invoices", {
      ...opts,
      registeredActions: ["archiveInvoice"],
    });
    expect(opts.onDo).toHaveBeenCalledWith("archiveInvoice", "inv-2");
  });

  it("do: refuses an action outside the allowlist, even if it parses as valid", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "do", action: "deleteAllInvoices" }, "/invoices", {
      ...opts,
      registeredActions: ["archiveInvoice"],
    });
    expect(opts.onDo).not.toHaveBeenCalled();
    expect(opts.onExplain).toHaveBeenCalledWith("That action isn't available here.");
  });

  it("do: refuses everything when no allowlist is configured — the injection test's core assertion", () => {
    const opts = makeOptions();
    executeVerbResponse(
      { verb: "do", action: "deleteAll" },
      "/invoices",
      opts, // no registeredActions passed at all
    );
    expect(opts.onDo).not.toHaveBeenCalled();
  });

  it("do: auto-executes a server-attached apiCall when the action isn't registered — no onDo involved", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const opts = makeOptions();
      executeVerbResponse(
        {
          verb: "do",
          action: "start-a-call",
          target: "start-call",
          text: "Starting the call now.",
          apiCall: { method: "POST", url: "/api/calls/start" },
        },
        "/invoices",
        opts,
      );
      // findElement gracefully returns null with no DOM in this test
      // environment, so the miss gets reported — the fetch itself doesn't
      // depend on that lookup succeeding.
      expect(opts.onMiss).toHaveBeenCalledWith({ attempted: "start-call", route: "/invoices" });
      expect(opts.onExplain).toHaveBeenCalledWith("Starting the call now.");
      expect(opts.onDo).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/calls/start", { method: "POST", credentials: "same-origin" }));
      // Success — no second, corrective onExplain call.
      expect(opts.onExplain).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("do: a failed apiCall follows up with a corrective explain instead of pretending it worked", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500 });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const opts = makeOptions();
      executeVerbResponse(
        {
          verb: "do",
          action: "start-a-call",
          text: "Starting the call now.",
          apiCall: { method: "POST", url: "/api/calls/start" },
        },
        "/invoices",
        opts,
      );
      await vi.waitFor(() => expect(opts.onExplain).toHaveBeenCalledTimes(2));
      expect(opts.onExplain).toHaveBeenNthCalledWith(
        2,
        "I tried to do that, but something went wrong — try again in a moment.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("do: a network failure (fetch throws) is treated the same as a failed response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    try {
      const opts = makeOptions();
      executeVerbResponse(
        { verb: "do", action: "start-a-call", apiCall: { method: "POST", url: "/api/calls/start" } },
        "/invoices",
        opts,
      );
      await vi.waitFor(() =>
        expect(opts.onExplain).toHaveBeenCalledWith("I tried to do that, but something went wrong — try again in a moment."),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("do: no apiCall and not registered — refused exactly as before, fetch never called", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const opts = makeOptions();
      executeVerbResponse({ verb: "do", action: "deleteAll" }, "/invoices", opts);
      expect(opts.onDo).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(opts.onExplain).toHaveBeenCalledWith("That action isn't available here.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  function fakeElement() {
    return {
      click: vi.fn(),
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    } as unknown as HTMLElement;
  }

  // highlightElement (element-ladder.ts) calls window.setTimeout — stub a
  // minimal window for these tests, same node environment gap the rest of
  // this suite already works around by not exercising highlight/open at all.
  function withWindowStub<T>(fn: () => T): T {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      return fn();
    } finally {
      vi.unstubAllGlobals();
    }
  }

  it("open: clicks the resolved target, not just highlights it", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["sessions-tab", el]]);
      executeVerbResponse({ verb: "open", target: "sessions-tab" }, "/admin", { ...opts, liveElements });
      expect(el.click).toHaveBeenCalledTimes(1);
    });
  });

  it("highlight: does NOT click, unlike open", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["invoice-table", el]]);
      executeVerbResponse({ verb: "highlight", target: "invoice-table" }, "/invoices", { ...opts, liveElements });
      expect(el.click).not.toHaveBeenCalled();
    });
  });

  it("do: click-first — a real, resolvable target is clicked directly, apiCall never fires even when both are present", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["archive-inv-2", el]]);
      executeVerbResponse(
        {
          verb: "do",
          action: "archive-invoice",
          target: "archive-inv-2",
          apiCall: { method: "POST", url: "/api/invoices/inv-2/archive" },
        },
        "/invoices",
        { ...opts, liveElements },
      );
      expect(el.click).toHaveBeenCalledTimes(1);
      // Give any stray microtask a chance to run — the apiCall path must never fire.
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(opts.onDo).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("do: target names a real element that just reveals UI, no apiCall at all — still clicks it for real (the 'New Agent' case)", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["new-agent-button", el]]);
      executeVerbResponse({ verb: "do", action: "create-agent", target: "new-agent-button" }, "/agents", { ...opts, liveElements });
      expect(el.click).toHaveBeenCalledTimes(1);
      expect(opts.onExplain).not.toHaveBeenCalledWith("That action isn't available here.");
    });
  });

  it("do: target can't be resolved live — falls back to firing apiCall directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const opts = makeOptions();
      executeVerbResponse(
        { verb: "do", action: "archive-invoice", target: "archive-inv-2", apiCall: { method: "POST", url: "/api/invoices/inv-2/archive" } },
        "/invoices",
        opts, // no liveElements at all — the element can't be found live
      );
      await vi.waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith("/api/invoices/inv-2/archive", { method: "POST", credentials: "same-origin" }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("degrades a verb outside the fixed enum to explain, never executes it", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "deleteAll", action: "deleteAll" }, "/invoices", opts);
    expect(opts.onDo).not.toHaveBeenCalled();
    expect(opts.onNavigate).not.toHaveBeenCalled();
    expect(opts.onExplain).toHaveBeenCalledTimes(1);
  });

  it("tour: forwards the raw steps to onTour, doesn't execute them itself", () => {
    const opts = makeOptions();
    const steps = [
      { text: "This is the invoice table.", target: "invoice-table" },
      { text: "Use this to create a new one.", target: "create-invoice" },
    ];
    executeVerbResponse({ verb: "tour", steps }, "/invoices", opts);
    expect(opts.onTour).toHaveBeenCalledWith(steps);
    expect(opts.onExplain).not.toHaveBeenCalled();
  });

  it("tour: degrades to a single explain when the caller doesn't support tours", () => {
    const opts = makeOptions();
    const steps = [
      { text: "This is the invoice table." },
      { text: "Use this to create a new one." },
    ];
    executeVerbResponse({ verb: "tour", steps }, "/invoices", { ...opts, onTour: undefined });
    expect(opts.onExplain).toHaveBeenCalledWith("This is the invoice table. Use this to create a new one.");
  });

  it("degrades malformed / non-object payloads to explain without throwing", () => {
    const opts = makeOptions();
    expect(() => executeVerbResponse(null, "/", opts)).not.toThrow();
    expect(() => executeVerbResponse("not json", "/", opts)).not.toThrow();
    expect(() => executeVerbResponse({ verb: "explain" }, "/", opts)).not.toThrow();
    expect(opts.onExplain).toHaveBeenCalledTimes(3);
  });
});

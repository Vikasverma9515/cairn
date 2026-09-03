import { describe, expect, it, vi } from "vitest";
import { executeToolStep, executeVerbResponse } from "./verb-executor";

function makeOptions() {
  return {
    onExplain: vi.fn(),
    onNavigate: vi.fn(),
    onDo: vi.fn(),
    onMiss: vi.fn(),
    onTour: vi.fn(),
    onToolStep: vi.fn(),
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

  it("click (agent loop): clicks the resolved target and reports a real observation, not a terminal explain", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["sessions-tab", el]]);
      executeVerbResponse({ verb: "click", target: "sessions-tab" }, "/admin", { ...opts, liveElements });
      expect(el.click).toHaveBeenCalledTimes(1);
      expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "click", target: "sessions-tab", ok: true, observation: "Clicked it." });
    });
  });

  it("click (agent loop): a miss reports a failed observation instead of a silent no-op", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "click", target: "does-not-exist" }, "/admin", opts);
    expect(opts.onToolStep).toHaveBeenCalledWith({
      verb: "click",
      target: "does-not-exist",
      ok: false,
      observation: "Could not find that element on the page.",
    });
    expect(opts.onMiss).toHaveBeenCalledWith({ attempted: "does-not-exist", route: "/admin" });
  });

  function fakeInput() {
    let value = "";
    return {
      tagName: "INPUT",
      get value() {
        return value;
      },
      set value(v: string) {
        value = v;
      },
      dispatchEvent: vi.fn(),
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    } as unknown as HTMLInputElement;
  }

  it("fill (agent loop): types into a real form field and reports the value back", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const input = fakeInput();
      const liveElements = new Map([["client-name", input]]);
      executeVerbResponse({ verb: "fill", target: "client-name", value: "Acme Co." }, "/invoices", { ...opts, liveElements });
      expect(input.value).toBe("Acme Co.");
      expect(opts.onToolStep).toHaveBeenCalledWith({
        verb: "fill",
        target: "client-name",
        ok: true,
        observation: 'Typed "Acme Co." into it.',
      });
    });
  });

  it("fill (agent loop): rejects a target that resolves but isn't a real form field", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const el = fakeElement(); // a plain button-shaped fake, not an HTMLInputElement
      const liveElements = new Map([["not-an-input", el]]);
      executeVerbResponse({ verb: "fill", target: "not-an-input", value: "hi" }, "/invoices", { ...opts, liveElements });
      expect(opts.onToolStep).toHaveBeenCalledWith({
        verb: "fill",
        target: "not-an-input",
        ok: false,
        observation: "That element isn't a real form field — can't type into it.",
      });
    });
  });

  it("read (agent loop): a miss reports a failed observation", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "read", target: "does-not-exist" }, "/invoices", opts);
    expect(opts.onToolStep).toHaveBeenCalledWith({
      verb: "read",
      target: "does-not-exist",
      ok: false,
      observation: "Could not find that element on the page.",
    });
  });

  it("call_tool (agent loop): calls the real WebMCP tool and reports its result", async () => {
    const executeTool = vi.fn().mockResolvedValue("3 overdue invoices");
    const tool = { name: "count-overdue-invoices" };
    vi.stubGlobal("document", { modelContext: { getTools: async () => [tool], executeTool } });
    try {
      const opts = makeOptions();
      executeVerbResponse({ verb: "call_tool", name: "count-overdue-invoices", args: {} }, "/invoices", opts);
      await vi.waitFor(() =>
        expect(opts.onToolStep).toHaveBeenCalledWith({
          verb: "call_tool",
          target: "count-overdue-invoices",
          ok: true,
          observation: "3 overdue invoices",
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("call_tool (agent loop): refuses a tool name not in this page's current WebMCP list", async () => {
    vi.stubGlobal("document", { modelContext: { getTools: async () => [], executeTool: vi.fn() } });
    try {
      const opts = makeOptions();
      executeVerbResponse({ verb: "call_tool", name: "delete-everything", args: {} }, "/invoices", opts);
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(opts.onToolStep.mock.calls[0][0].ok).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Unlike withWindowStub (synchronous-only — it tears the stub down the
  // instant the wrapped callback returns), a batch keeps running asynchronously
  // (executeBatchActions' .then()) after executeVerbResponse itself returns,
  // and click/fill actions inside it still need window.setTimeout (via
  // highlightElement) for that whole duration — so these tests stub/unstub
  // around the awaited result instead.
  it("batch: executes each action in order and reports one combined observation", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      const opts = makeOptions();
      const el = fakeElement();
      const input = fakeInput();
      const liveElements = new Map([
        ["invoice-table", el],
        ["client-name", input],
      ]);
      executeVerbResponse(
        {
          verb: "batch",
          actions: [
            { verb: "read", target: "invoice-table" },
            { verb: "fill", target: "client-name", value: "Acme Co." },
          ],
        },
        "/invoices",
        { ...opts, liveElements },
      );
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(input.value).toBe("Acme Co.");
      const result = opts.onToolStep.mock.calls[0][0];
      expect(result.verb).toBe("batch");
      expect(result.ok).toBe(true);
      expect(result.observation).toContain('Typed "Acme Co." into it.');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("batch: stops at the first failure instead of continuing to act on a plan that no longer holds", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["real-target", el]]);
      executeVerbResponse(
        {
          verb: "batch",
          actions: [
            { verb: "click", target: "does-not-exist" },
            { verb: "click", target: "real-target" },
          ],
        },
        "/invoices",
        { ...opts, liveElements },
      );
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      // The second action never ran — its target was never clicked.
      expect(el.click).not.toHaveBeenCalled();
      const result = opts.onToolStep.mock.calls[0][0];
      expect(result.ok).toBe(false);
      expect(result.observation).toContain("Could not find that element on the page.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("batch: a call_tool step inside the batch calls the real WebMCP tool", async () => {
    const executeTool = vi.fn().mockResolvedValue("3 overdue invoices");
    vi.stubGlobal("document", { modelContext: { getTools: async () => [{ name: "count-overdue-invoices" }], executeTool } });
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      const opts = makeOptions();
      const el = fakeElement();
      const liveElements = new Map([["archive-btn", el]]);
      executeVerbResponse(
        {
          verb: "batch",
          actions: [
            { verb: "call_tool", name: "count-overdue-invoices", args: {} },
            { verb: "click", target: "archive-btn" },
          ],
        },
        "/invoices",
        { ...opts, liveElements },
      );
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(executeTool).toHaveBeenCalled();
      expect(el.click).toHaveBeenCalledTimes(1);
      expect(opts.onToolStep.mock.calls[0][0].ok).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Phase 3 step 4, real positive case: a batch action's target isn't found on the first lookup but becomes available during the bounded retry (a real re-render) — the batch action still succeeds instead of stopping the whole batch on a transient miss", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      const opts = makeOptions();
      const el = fakeElement();
      const el2 = fakeElement();
      // archive-btn-2 is present from the start (BatchActionSchema
      // requires >= 2 actions, so a second, unrelated real step rounds
      // this out realistically); archive-btn itself is missing at the
      // start — simulates it not yet being in this turn's frozen
      // liveElements snapshot — then populated shortly after, during
      // findElementWithRetry's own real wait, simulating a re-render
      // finishing.
      const liveElements = new Map<string, any>([["archive-btn-2", el2]]);
      setTimeout(() => liveElements.set("archive-btn", el), 10);

      executeVerbResponse(
        {
          verb: "batch",
          actions: [
            { verb: "click", target: "archive-btn" },
            { verb: "click", target: "archive-btn-2" },
          ],
        },
        "/invoices",
        { ...opts, liveElements },
      );

      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled(), { timeout: 2000 });
      expect(el.click).toHaveBeenCalledTimes(1);
      expect(el2.click).toHaveBeenCalledTimes(1); // the batch continued past the first (recovered) step
      const result = opts.onToolStep.mock.calls[0][0];
      expect(result.ok).toBe(true);
      expect(result.observation).toContain("Clicked it.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("executeToolStep: resolves with the real observation for a synchronous step (click)", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    try {
      const el = fakeElement();
      const liveElements = new Map([["archive-btn", el]]);
      const result = await executeToolStep({ verb: "click", target: "archive-btn" }, "/invoices", liveElements);
      expect(result).toEqual({ verb: "click", target: "archive-btn", ok: true, observation: "Clicked it." });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("executeToolStep: resolves with the real observation for an async step (call_tool)", async () => {
    vi.stubGlobal("document", {
      modelContext: {
        getTools: async () => [{ name: "search-products" }],
        executeTool: async () => "3 results",
      },
    });
    try {
      const result = await executeToolStep({ verb: "call_tool", name: "search-products", args: {} }, "/invoices");
      expect(result).toEqual({ verb: "call_tool", target: "search-products", ok: true, observation: "3 results" });
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

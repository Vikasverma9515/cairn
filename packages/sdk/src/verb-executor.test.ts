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

  it("navigate: with no continueAfter, never calls onToolStep even when the caller provides one — the plain 'take me to X' case ends the turn exactly as before", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "navigate", route: "/invoices" }, "/", opts);
    expect(opts.onToolStep).not.toHaveBeenCalled();
  });

  // Real, live-reported gap this closes: navigate was ALWAYS terminal, so
  // "buy earbuds" (navigate, then search, then report back) ended the turn
  // the instant it navigated. See isTerminalVerb in @cairnvibe/core.
  it("navigate: continueAfter true executes the real navigation AND reports a real observation via onToolStep, continuing the loop", async () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "navigate", route: "/shop", continueAfter: true }, "/", opts);
    expect(opts.onNavigate).toHaveBeenCalledWith("/shop"); // the real navigation still happens immediately, not deferred
    await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "navigate", target: "/shop", ok: true, observation: "Navigated to /shop." }));
  });

  it("navigate: continueAfter true still speaks any real text before navigating, same as the terminal case", async () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "navigate", route: "/shop", continueAfter: true, text: "Taking you to the shop" }, "/", opts);
    expect(opts.onExplain).toHaveBeenCalledWith("Taking you to the shop");
    await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
  });

  it("navigate: continueAfter true with no onToolStep provided by the caller defensively falls back to the plain terminal behavior instead of silently dropping the navigation", () => {
    const { onToolStep: _onToolStep, ...optsWithoutToolStep } = makeOptions();
    executeVerbResponse({ verb: "navigate", route: "/shop", continueAfter: true }, "/", optsWithoutToolStep);
    expect(optsWithoutToolStep.onNavigate).toHaveBeenCalledWith("/shop");
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

  it("click (agent loop): clicks the resolved target and reports a real observation, not a terminal explain", async () => {
    const opts = makeOptions();
    const el = fakeElement();
    const liveElements = new Map([["sessions-tab", el]]);
    withWindowStub(() => {
      executeVerbResponse({ verb: "click", target: "sessions-tab" }, "/admin", { ...opts, liveElements });
    });
    expect(el.click).toHaveBeenCalledTimes(1);
    // onToolStep now fires after waitForDomSettle's own promise resolves
    // (element-ladder.ts) — a real microtask hop even on its "no document,
    // resolve immediately" fast path, not a synchronous call anymore.
    // window is already unstubbed by here, but nothing past this point
    // needs it — highlightElement's window.setTimeout already ran above.
    await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "click", target: "sessions-tab", ok: true, observation: "Clicked it." }));
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

  it("fill (agent loop): types into a real form field and reports the value back", async () => {
    const opts = makeOptions();
    const input = fakeInput();
    const liveElements = new Map([["client-name", input]]);
    withWindowStub(() => {
      executeVerbResponse({ verb: "fill", target: "client-name", value: "Acme Co." }, "/invoices", { ...opts, liveElements });
    });
    expect(input.value).toBe("Acme Co.");
    // See the click test's own comment — onToolStep is a microtask hop
    // away now (waitForDomSettle), not synchronous.
    await vi.waitFor(() =>
      expect(opts.onToolStep).toHaveBeenCalledWith({
        verb: "fill",
        target: "client-name",
        ok: true,
        observation: 'Typed "Acme Co." into it.',
      }),
    );
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

  // Hand-rolled Node stand-ins for the browser event constructors dragElement/
  // pressKey use (element-ladder.ts) — same reasoning as this file's own
  // fakeElement/fakeInput: no jsdom in this repo's test environment.
  class FakeMouseEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }
  class FakeKeyboardEvent {
    type: string;
    key: string;
    constructor(type: string, opts: { key: string }) {
      this.type = type;
      this.key = opts.key;
    }
  }

  function fakeDraggable(rect: { left: number; top: number; width: number; height: number }) {
    return {
      getBoundingClientRect: () => rect,
      dispatchEvent: vi.fn(),
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    } as unknown as HTMLElement;
  }

  it("drag (agent loop): drags the resolved source onto the resolved destination and reports a real observation", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    try {
      const opts = makeOptions();
      const from = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
      const to = fakeDraggable({ left: 100, top: 100, width: 10, height: 10 });
      const liveElements = new Map([
        ["node-a", from],
        ["node-b", to],
      ]);
      executeVerbResponse({ verb: "drag", target: "node-a", to: "node-b" }, "/canvas", { ...opts, liveElements });
      expect((from.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.some((c) => (c[0] as FakeMouseEvent).type === "mousedown")).toBe(true);
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "drag", target: "node-a", ok: true, observation: "Dragged it to node-b." }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("drag (agent loop): a miss on the source reports a failed observation and never touches the destination", () => {
    const opts = makeOptions();
    const to = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
    const liveElements = new Map([["node-b", to]]);
    executeVerbResponse({ verb: "drag", target: "does-not-exist", to: "node-b" }, "/canvas", { ...opts, liveElements });
    expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "drag", target: "does-not-exist", ok: false, observation: "Could not find that element on the page." });
    expect(to.dispatchEvent).not.toHaveBeenCalled();
  });

  it("drag (agent loop): a miss on the destination reports its own distinct observation", () => {
    const opts = makeOptions();
    const from = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
    const liveElements = new Map([["node-a", from]]);
    executeVerbResponse({ verb: "drag", target: "node-a", to: "does-not-exist" }, "/canvas", { ...opts, liveElements });
    expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "drag", target: "node-a", ok: false, observation: "Could not find the drop destination on the page." });
  });

  function fakeSelect(optionPairs: { text: string; value: string }[]) {
    return {
      tagName: "SELECT",
      value: "",
      options: optionPairs.map((o) => ({ textContent: o.text, value: o.value })),
      dispatchEvent: vi.fn(),
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    } as unknown as HTMLSelectElement;
  }

  it("select (agent loop): chooses the real option by its visible text and reports the value back", async () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const select = fakeSelect([
        { text: "Paid", value: "PAID" },
        { text: "Overdue", value: "OVERDUE" },
      ]);
      const liveElements = new Map([["status-dropdown", select]]);
      executeVerbResponse({ verb: "select", target: "status-dropdown", value: "Overdue" }, "/invoices", { ...opts, liveElements });
      expect(select.value).toBe("OVERDUE");
    });
  });

  it("select (agent loop): no matching option reports a failed observation instead of guessing", () => {
    withWindowStub(() => {
      const opts = makeOptions();
      const select = fakeSelect([{ text: "Paid", value: "PAID" }]);
      const liveElements = new Map([["status-dropdown", select]]);
      executeVerbResponse({ verb: "select", target: "status-dropdown", value: "Cancelled" }, "/invoices", { ...opts, liveElements });
      expect(opts.onToolStep).toHaveBeenCalledWith({
        verb: "select",
        target: "status-dropdown",
        ok: false,
        observation: 'Could not find an option matching "Cancelled".',
      });
    });
  });

  it("key (agent loop): presses the key on the resolved target and reports it", () => {
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    try {
      const opts = makeOptions();
      const input = fakeInput();
      const liveElements = new Map([["search-box", input]]);
      executeVerbResponse({ verb: "key", target: "search-box", key: "Enter" }, "/invoices", { ...opts, liveElements });
      const events = (input.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as FakeKeyboardEvent).type);
      expect(events).toEqual(["keydown", "keypress", "keyup"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("key (agent loop): with no target, presses the key on whatever's currently focused", () => {
    const activeElement = { focus: vi.fn(), dispatchEvent: vi.fn() } as unknown as HTMLElement;
    vi.stubGlobal("document", { activeElement });
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    try {
      const opts = makeOptions();
      executeVerbResponse({ verb: "key", key: "Escape" }, "/invoices", opts);
      expect(activeElement.focus).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("key (agent loop): a named target that isn't found reports a failed observation", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "key", target: "does-not-exist", key: "Tab" }, "/invoices", opts);
    expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "key", target: "does-not-exist", ok: false, observation: "Could not find that element on the page." });
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

  it("call_tool (agent loop): Architecture Pillar 6 — a 'confirm'-tier tool waits for onConfirmTool before executing", async () => {
    const executeTool = vi.fn().mockResolvedValue("Archived.");
    const tool = { name: "archive-invoice", description: "Archives the invoice; cannot be undone.", riskTier: "confirm" };
    vi.stubGlobal("document", { modelContext: { getTools: async () => [tool], executeTool } });
    try {
      const opts = makeOptions();
      const onConfirmTool = vi.fn().mockResolvedValue(true);
      executeVerbResponse({ verb: "call_tool", name: "archive-invoice", args: {} }, "/invoices", { ...opts, onConfirmTool });
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(onConfirmTool).toHaveBeenCalledWith({ name: "archive-invoice", description: "Archives the invoice; cannot be undone." });
      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(opts.onToolStep).toHaveBeenCalledWith({ verb: "call_tool", target: "archive-invoice", ok: true, observation: "Archived." });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("call_tool (agent loop): no onConfirmTool wired up means a 'confirm'-tier tool is declined by default, never silently executed", async () => {
    const executeTool = vi.fn();
    const tool = { name: "archive-invoice", riskTier: "confirm" };
    vi.stubGlobal("document", { modelContext: { getTools: async () => [tool], executeTool } });
    try {
      const opts = makeOptions();
      executeVerbResponse({ verb: "call_tool", name: "archive-invoice", args: {} }, "/invoices", opts); // no onConfirmTool
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(executeTool).not.toHaveBeenCalled();
      expect(opts.onToolStep.mock.calls[0][0].ok).toBe(false);
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

  it("batch: drag/select/key steps run in order alongside the original four verbs", async () => {
    vi.stubGlobal("window", { setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms) });
    vi.stubGlobal("MouseEvent", FakeMouseEvent);
    vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
    try {
      const opts = makeOptions();
      const from = fakeDraggable({ left: 0, top: 0, width: 10, height: 10 });
      const to = fakeDraggable({ left: 50, top: 50, width: 10, height: 10 });
      const select = fakeSelect([{ text: "Overdue", value: "OVERDUE" }]);
      const input = fakeInput();
      const liveElements = new Map<string, any>([
        ["node-a", from],
        ["node-b", to],
        ["status-dropdown", select],
        ["search-box", input],
      ]);
      executeVerbResponse(
        {
          verb: "batch",
          actions: [
            { verb: "drag", target: "node-a", to: "node-b" },
            { verb: "select", target: "status-dropdown", value: "Overdue" },
            { verb: "key", target: "search-box", key: "Enter" },
          ],
        },
        "/canvas",
        { ...opts, liveElements },
      );
      await vi.waitFor(() => expect(opts.onToolStep).toHaveBeenCalled());
      expect(select.value).toBe("OVERDUE");
      const result = opts.onToolStep.mock.calls[0][0];
      expect(result.verb).toBe("batch");
      expect(result.ok).toBe(true);
      expect(result.observation).toContain("Dragged it to node-b.");
      expect(result.observation).toContain('Selected "Overdue".');
      expect(result.observation).toContain("Pressed Enter.");
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

  it("executeToolStep: a continueAfter navigate calls the passed onNavigate and resolves with a real observation — the real fix for a compound goal that starts with navigation", async () => {
    const onNavigate = vi.fn();
    const result = await executeToolStep({ verb: "navigate", route: "/shop", continueAfter: true }, "/", undefined, onNavigate);
    expect(onNavigate).toHaveBeenCalledWith("/shop");
    expect(result).toEqual({ verb: "navigate", target: "/shop", ok: true, observation: "Navigated to /shop." });
  });

  it("executeToolStep: a continueAfter navigate with no onNavigate passed still resolves (just doesn't move the page) — never hangs the loop waiting on a callback the caller didn't provide", async () => {
    const result = await executeToolStep({ verb: "navigate", route: "/shop", continueAfter: true }, "/");
    expect(result).toEqual({ verb: "navigate", target: "/shop", ok: true, observation: "Navigated to /shop." });
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

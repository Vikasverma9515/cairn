import { describe, expect, it, vi } from "vitest";
import { executeVerbResponse } from "./verb-executor";

function makeOptions() {
  return {
    onExplain: vi.fn(),
    onNavigate: vi.fn(),
    onDo: vi.fn(),
    onMiss: vi.fn(),
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
    expect(opts.onDo).toHaveBeenCalledWith("archiveInvoice");
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

  it("degrades a verb outside the fixed enum to explain, never executes it", () => {
    const opts = makeOptions();
    executeVerbResponse({ verb: "deleteAll", action: "deleteAll" }, "/invoices", opts);
    expect(opts.onDo).not.toHaveBeenCalled();
    expect(opts.onNavigate).not.toHaveBeenCalled();
    expect(opts.onExplain).toHaveBeenCalledTimes(1);
  });

  it("degrades malformed / non-object payloads to explain without throwing", () => {
    const opts = makeOptions();
    expect(() => executeVerbResponse(null, "/", opts)).not.toThrow();
    expect(() => executeVerbResponse("not json", "/", opts)).not.toThrow();
    expect(() => executeVerbResponse({ verb: "explain" }, "/", opts)).not.toThrow();
    expect(opts.onExplain).toHaveBeenCalledTimes(3);
  });
});

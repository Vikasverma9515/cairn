import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverWebMcpTools, executeWebMcpTool } from "./webmcp-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discoverWebMcpTools", () => {
  it("returns an empty list when the page has no modelContext at all — the common case today", async () => {
    vi.stubGlobal("document", {});
    expect(await discoverWebMcpTools()).toEqual([]);
  });

  it("returns an empty list outside a browser (no document)", async () => {
    expect(await discoverWebMcpTools()).toEqual([]);
  });

  it("normalizes real registered tools into the bounded WebMcpTool shape", async () => {
    vi.stubGlobal("document", {
      modelContext: {
        getTools: async () => [
          { name: "search-products", description: "Search the catalog", inputSchema: { type: "object" } },
        ],
      },
    });
    expect(await discoverWebMcpTools()).toEqual([
      { name: "search-products", description: "Search the catalog", inputSchema: { type: "object" } },
    ]);
  });

  it("degrades to an empty list if the page's own getTools() throws", async () => {
    vi.stubGlobal("document", {
      modelContext: {
        getTools: async () => {
          throw new Error("page bug");
        },
      },
    });
    expect(await discoverWebMcpTools()).toEqual([]);
  });

  it("caps the tool count at 30", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ name: `tool-${i}`, description: "x" }));
    vi.stubGlobal("document", { modelContext: { getTools: async () => many } });
    expect(await discoverWebMcpTools()).toHaveLength(30);
  });
});

describe("executeWebMcpTool", () => {
  it("calls the real tool's executeTool with the matched tool object and args, returns its result as text", async () => {
    const executeTool = vi.fn().mockResolvedValue({ results: ["Laptop A", "Laptop B"] });
    const tool = { name: "search-products", description: "x" };
    vi.stubGlobal("document", { modelContext: { getTools: async () => [tool], executeTool } });

    const result = await executeWebMcpTool("search-products", { query: "laptops" });
    expect(executeTool).toHaveBeenCalledWith(tool, { query: "laptops" });
    expect(result.ok).toBe(true);
    expect(result.observation).toContain("Laptop A");
  });

  it("refuses a tool name that isn't in this page's current tool list — never invented", async () => {
    vi.stubGlobal("document", {
      modelContext: { getTools: async () => [{ name: "search-products" }], executeTool: vi.fn() },
    });
    const result = await executeWebMcpTool("delete-everything", {});
    expect(result.ok).toBe(false);
    expect(result.observation).toContain("No tool named");
  });

  it("reports a real tool failure as a failed observation instead of throwing", async () => {
    const tool = { name: "search-products" };
    vi.stubGlobal("document", {
      modelContext: {
        getTools: async () => [tool],
        executeTool: async () => {
          throw new Error("upstream API down");
        },
      },
    });
    const result = await executeWebMcpTool("search-products", {});
    expect(result.ok).toBe(false);
    expect(result.observation).toContain("upstream API down");
  });

  it("degrades cleanly when there's no modelContext at all", async () => {
    vi.stubGlobal("document", {});
    const result = await executeWebMcpTool("search-products", {});
    expect(result.ok).toBe(false);
  });
});

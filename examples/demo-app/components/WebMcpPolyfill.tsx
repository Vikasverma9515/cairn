"use client";

/**
 * A minimal, demo-only polyfill for document.modelContext
 * (https://webmachinelearning.github.io/webmcp/) — no real browser
 * implements this yet (it's a proposed, in-progress standard), so this
 * exists purely to prove Cairn's WebMCP *consumer* side (webmcp-client.ts)
 * actually works end-to-end against the real API shape, ahead of real
 * browser support landing. A production app doesn't need this — once
 * browsers implement WebMCP natively, real registerTool() calls (like
 * InvoiceWebMcpTools.tsx's) start working with zero changes.
 *
 * Installed at MODULE scope, not inside a useEffect — a page's own
 * registerTool() call (also in a useEffect, deeper in the tree) would
 * otherwise run before this one does (React commits child effects before
 * parent effects), finding no document.modelContext yet to register into.
 * Importing this file for its side effect (see layout.tsx) runs it
 * immediately, ahead of any component's effects.
 */
if (typeof document !== "undefined") {
  const doc = document as unknown as { modelContext?: any };
  if (!doc.modelContext) {
    const tools: { name: string; title?: string; description: string; inputSchema?: unknown; execute: (args: unknown) => Promise<unknown> }[] = [];

    doc.modelContext = {
      registerTool: async (tool: (typeof tools)[number]) => {
        tools.push(tool);
        return {
          remove: () => {
            const i = tools.indexOf(tool);
            if (i !== -1) tools.splice(i, 1);
          },
        };
      },
      getTools: async () => tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })),
      executeTool: async (tool: { name: string }, args: unknown) => {
        const real = tools.find((t) => t.name === tool.name);
        if (!real) throw new Error(`No such tool: ${tool.name}`);
        return real.execute(args);
      },
    };
  }
}

// No component export — this file exists purely for its module-scope side
// effect above. Imported once, for that effect, from layout.tsx.
export {};

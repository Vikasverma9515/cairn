"use client";

import { useEffect } from "react";
import type { Invoice } from "../lib/invoices";

// A real WebMCP tool (https://webmachinelearning.github.io/webmcp/) — the
// highest-trust action source Cairn can use: a real function this page's
// own developer wrote, with a real typed input and a real return value,
// not a click simulated from static analysis. Registered purely client-
// side; a page with no Cairn installed at all still works exactly the
// same, and any WebMCP-aware agent (not just Cairn) can discover this.
export function InvoiceWebMcpTools({ invoices }: { invoices: Invoice[] }) {
  useEffect(() => {
    const modelContext = (document as unknown as { modelContext?: any }).modelContext;
    if (!modelContext?.registerTool) return;

    let unregistered = false;
    const handles: { remove?: () => void }[] = [];
    const register = (tool: Record<string, unknown>) =>
      void modelContext
        .registerTool(tool)
        .then((registered: { remove?: () => void }) => {
          if (unregistered) registered?.remove?.();
          else handles.push(registered);
        })
        .catch(() => {
          // A page without a real WebMCP implementation (the overwhelming
          // majority right now) — nothing to do, this is expected.
        });

    register({
      name: "count-overdue-invoices",
      title: "Count overdue invoices",
      description: "Returns how many invoices are currently overdue, and their client names.",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        const overdue = invoices.filter((inv) => inv.status === "Overdue");
        return { count: overdue.length, clients: overdue.map((inv) => inv.client) };
      },
    });

    // Architecture Pillar 6 (the safety layer) — a real, mutating,
    // hard-to-undo tool, deliberately marked `riskTier: "confirm"` so
    // Cairn's own executeWebMcpTool gates it behind a genuine end-user
    // yes (see webmcp-client.ts) instead of letting the model archive an
    // invoice on its own say-so just because a tool for it exists.
    register({
      name: "archive-invoice-by-client",
      title: "Archive an invoice by client name",
      description: "Archives the named client's invoice. This cannot be undone.",
      inputSchema: { type: "object", properties: { client: { type: "string" } }, required: ["client"] },
      riskTier: "confirm",
      execute: async ({ client }: { client: string }) => {
        const invoice = invoices.find((inv) => inv.client.toLowerCase() === client.toLowerCase());
        if (!invoice) return { ok: false, message: `No invoice found for "${client}".` };
        const res = await fetch(`/api/invoices/${invoice.id}/archive`, { method: "POST" });
        return { ok: res.ok, message: res.ok ? `${client}'s invoice is now archived.` : "The archive request failed." };
      },
    });

    return () => {
      unregistered = true;
      for (const handle of handles) handle?.remove?.();
    };
  }, [invoices]);

  return null;
}

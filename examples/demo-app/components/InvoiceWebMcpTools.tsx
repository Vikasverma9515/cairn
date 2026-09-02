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
    let handle: { remove?: () => void } | undefined;
    void modelContext
      .registerTool({
        name: "count-overdue-invoices",
        title: "Count overdue invoices",
        description: "Returns how many invoices are currently overdue, and their client names.",
        inputSchema: { type: "object", properties: {} },
        execute: async () => {
          const overdue = invoices.filter((inv) => inv.status === "Overdue");
          return { count: overdue.length, clients: overdue.map((inv) => inv.client) };
        },
      })
      .then((registered: { remove?: () => void }) => {
        if (unregistered) registered?.remove?.();
        else handle = registered;
      })
      .catch(() => {
        // A page without a real WebMCP implementation (the overwhelming
        // majority right now) — nothing to do, this is expected.
      });

    return () => {
      unregistered = true;
      handle?.remove?.();
    };
  }, [invoices]);

  return null;
}

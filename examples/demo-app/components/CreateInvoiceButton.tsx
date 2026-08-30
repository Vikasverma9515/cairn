"use client";

import { Plus } from "lucide-react";

export function CreateInvoiceButton() {
  async function handleCreate() {
    await fetch("/api/invoices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    window.location.reload();
  }

  return (
    <button
      data-ai="create-invoice"
      onClick={handleCreate}
      className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-gray-800"
    >
      <Plus size={16} /> New Invoice
    </button>
  );
}

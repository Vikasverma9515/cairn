"use client";

import { Archive } from "lucide-react";

export function ArchiveInvoiceButton({ id }: { id: string }) {
  async function handleArchive() {
    await fetch(`/api/invoices/${id}/archive`, { method: "POST" });
    window.location.reload();
  }

  return (
    <button
      data-ai={`archive-${id}`}
      onClick={handleArchive}
      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-600 transition hover:border-gray-300 hover:bg-gray-50"
    >
      <Archive size={13} /> Archive
    </button>
  );
}

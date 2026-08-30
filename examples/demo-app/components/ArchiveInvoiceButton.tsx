"use client";

export function ArchiveInvoiceButton({ id }: { id: string }) {
  async function handleArchive() {
    await fetch(`/api/invoices/${id}/archive`, { method: "POST" });
    window.location.reload();
  }

  return (
    <button data-ai={`archive-${id}`} onClick={handleArchive}>
      Archive
    </button>
  );
}

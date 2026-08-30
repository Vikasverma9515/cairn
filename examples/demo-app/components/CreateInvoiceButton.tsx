"use client";

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
    <button data-ai="create-invoice" onClick={handleCreate}>
      New Invoice
    </button>
  );
}

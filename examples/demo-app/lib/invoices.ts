// In-memory demo store — module-level singleton, resets on server restart.
// Good enough to prove the archive flow end-to-end; a real app would hit a database.

export interface Invoice {
  id: string;
  client: string;
  amount: string;
  status: "Paid" | "Overdue" | "Archived";
}

const invoices: Invoice[] = [
  { id: "inv-1", client: "Acme Co.", amount: "$1,200.00", status: "Paid" },
  { id: "inv-2", client: "Globex Inc.", amount: "$450.00", status: "Overdue" },
];

export function listInvoices(): Invoice[] {
  return invoices;
}

export function createInvoice(): Invoice {
  const invoice: Invoice = { id: `inv-${Date.now()}`, client: "New Client", amount: "$0.00", status: "Overdue" };
  invoices.push(invoice);
  return invoice;
}

export function archiveInvoice(id: string): Invoice | null {
  const invoice = invoices.find((i) => i.id === id);
  if (!invoice) return null;
  invoice.status = "Archived";
  return invoice;
}

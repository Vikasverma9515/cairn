// Persisted in SQLite (lib/db.ts) — survives restarts and hot reloads.
// Same exported function signatures as before, so nothing that calls these
// (InvoiceList, ArchiveInvoiceButton, the API routes) needs to change.
import { db } from "./db";

export interface Invoice {
  id: string;
  client: string;
  amount: string;
  status: "Paid" | "Overdue" | "Archived";
}

seedIfEmpty();

export function listInvoices(): Invoice[] {
  return db.prepare("SELECT id, client, amount, status FROM invoices ORDER BY rowid ASC").all() as Invoice[];
}

export function createInvoice(): Invoice {
  const invoice: Invoice = { id: `inv-${Date.now()}`, client: "New Client", amount: "$0.00", status: "Overdue" };
  db.prepare("INSERT INTO invoices (id, client, amount, status) VALUES (?, ?, ?, ?)").run(
    invoice.id,
    invoice.client,
    invoice.amount,
    invoice.status,
  );
  return invoice;
}

export function archiveInvoice(id: string): Invoice | null {
  const result = db.prepare("UPDATE invoices SET status = 'Archived' WHERE id = ?").run(id);
  if (result.changes === 0) return null;
  return db.prepare("SELECT id, client, amount, status FROM invoices WHERE id = ?").get(id) as Invoice;
}

function seedIfEmpty(): void {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM invoices").get() as { count: number };
  if (count > 0) return;
  const insert = db.prepare("INSERT INTO invoices (id, client, amount, status) VALUES (?, ?, ?, ?)");
  insert.run("inv-1", "Acme Co.", "$1,200.00", "Paid");
  insert.run("inv-2", "Globex Inc.", "$450.00", "Overdue");
}

/** Test-utility for @cairnvibe/evals — resets to the same two seed rows
 * seedIfEmpty starts with, so a scenario's before/after check is
 * deterministic instead of accumulating rows across runs. Dev/eval fixture
 * only, same as workflows.ts's resetWorkflow. */
export function resetInvoices(): void {
  db.prepare("DELETE FROM invoices").run();
  seedIfEmpty();
}

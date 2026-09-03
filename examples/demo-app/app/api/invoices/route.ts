import { NextResponse } from "next/server";
import { createInvoice, listInvoices } from "../../../lib/invoices";

// GET added for @cairnvibe/evals — a real way to verify a scenario's final
// state without scraping rendered HTML (the page itself already calls
// listInvoices() server-side directly; this is the same data over HTTP).
export async function GET() {
  return NextResponse.json(listInvoices());
}

export async function POST() {
  const invoice = createInvoice();
  return NextResponse.json(invoice, { status: 201 });
}

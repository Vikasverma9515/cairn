// Test-utility endpoint for @cairnvibe/evals — see resetInvoices's doc
// comment in lib/invoices.ts. Dev/eval fixture only, same as
// /api/workflows/reset.
import { NextResponse } from "next/server";
import { resetInvoices } from "../../../../lib/invoices";

export async function POST() {
  resetInvoices();
  return NextResponse.json({ ok: true });
}

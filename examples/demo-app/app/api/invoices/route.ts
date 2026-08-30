import { NextResponse } from "next/server";
import { createInvoice } from "../../../lib/invoices";

export async function POST() {
  const invoice = createInvoice();
  return NextResponse.json(invoice, { status: 201 });
}

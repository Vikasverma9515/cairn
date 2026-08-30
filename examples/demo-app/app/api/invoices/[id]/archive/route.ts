import { NextResponse } from "next/server";
import { archiveInvoice } from "../../../../../lib/invoices";

export async function POST(_request: Request, { params }: { params: { id: string } }) {
  const invoice = archiveInvoice(params.id);
  if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(invoice);
}

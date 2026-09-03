// Test-utility endpoint for @cairnvibe/evals — see resetShop's doc
// comment in lib/shop.ts. Dev/eval fixture only, same as
// /api/invoices/reset, /api/workflows/reset, /api/board/reset.
import { NextResponse } from "next/server";
import { resetShop } from "../../../../lib/shop";

export async function POST() {
  resetShop();
  return NextResponse.json({ ok: true });
}

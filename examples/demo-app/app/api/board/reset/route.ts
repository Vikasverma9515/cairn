// Test-utility endpoint for @cairnvibe/evals — see resetBoard's doc
// comment in lib/board.ts. Dev/eval fixture only, same as
// /api/invoices/reset and /api/workflows/reset.
import { NextResponse } from "next/server";
import { resetBoard } from "../../../../lib/board";

export async function POST() {
  resetBoard();
  return NextResponse.json({ ok: true });
}

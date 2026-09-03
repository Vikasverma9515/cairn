import { NextResponse } from "next/server";
import { listOrders } from "../../../../lib/shop";

// The wizard primitive's real observePath — what verify checks against
// to confirm a checkout actually completed.
export async function GET() {
  return NextResponse.json(listOrders());
}

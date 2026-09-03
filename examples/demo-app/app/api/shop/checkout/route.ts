import { NextResponse } from "next/server";
import { isLoggedIn, placeOrder } from "../../../../lib/shop";

// The wizard primitive's final step — real 403 when the auth-gate
// constraint isn't satisfied, real 400 when the cart is empty, so an
// agent driving this flow gets a real signal to recover from, not a
// silent no-op.
export async function POST(request: Request) {
  if (!isLoggedIn()) return NextResponse.json({ error: "not logged in" }, { status: 403 });
  const body = (await request.json()) as { email?: string; address?: string };
  if (!body.email || !body.address) return NextResponse.json({ error: "email and address are required" }, { status: 400 });
  const order = placeOrder(body.email, body.address);
  if (!order) return NextResponse.json({ error: "cart is empty" }, { status: 400 });
  return NextResponse.json(order, { status: 201 });
}

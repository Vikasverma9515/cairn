import { NextResponse } from "next/server";
import { addToCart, listCart } from "../../../../lib/shop";

export async function GET() {
  return NextResponse.json(listCart());
}

export async function POST(request: Request) {
  const body = (await request.json()) as { productId?: string; quantity?: number };
  if (!body.productId) return NextResponse.json({ error: "productId is required" }, { status: 400 });
  addToCart(body.productId, body.quantity ?? 1);
  return NextResponse.json(listCart(), { status: 201 });
}

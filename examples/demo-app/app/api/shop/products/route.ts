import { NextResponse } from "next/server";
import { listProducts } from "../../../../lib/shop";

// The search-filter primitive's observePath.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? undefined;
  const category = searchParams.get("category") ?? undefined;
  return NextResponse.json(listProducts({ q, category }));
}

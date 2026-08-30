import { NextResponse } from "next/server";
import { missesHandler } from "../../../../lib/misses-store";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const result = await missesHandler.post(body);
  return NextResponse.json(result.body, { status: result.status });
}

export async function GET() {
  const result = await missesHandler.get();
  return NextResponse.json(result.body, { status: result.status });
}

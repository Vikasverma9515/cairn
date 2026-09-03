import { NextResponse } from "next/server";
import { connectNodes } from "../../../../lib/workflows";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const from = body?.from as string | undefined;
  const to = body?.to as string | undefined;
  if (!from || !to) return NextResponse.json({ error: "missing from/to" }, { status: 400 });
  const edge = connectNodes(from, to);
  if (!edge) return NextResponse.json({ error: "unknown node id" }, { status: 400 });
  return NextResponse.json(edge, { status: 201 });
}

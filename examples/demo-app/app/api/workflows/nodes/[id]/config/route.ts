import { NextResponse } from "next/server";
import { configureNode } from "../../../../../../lib/workflows";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = await request.json().catch(() => ({}));
  const config = body?.config as Record<string, string> | undefined;
  if (!config) return NextResponse.json({ error: "missing config" }, { status: 400 });
  const node = configureNode(params.id, config);
  if (!node) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(node);
}

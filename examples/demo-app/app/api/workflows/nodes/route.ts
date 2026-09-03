import { NextResponse } from "next/server";
import { addNode, type NodeType } from "../../../../lib/workflows";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const type = body?.type as NodeType | undefined;
  if (!type) return NextResponse.json({ error: "missing type" }, { status: 400 });
  try {
    return NextResponse.json(addNode(type), { status: 201 });
  } catch {
    return NextResponse.json({ error: "unknown node type" }, { status: 400 });
  }
}

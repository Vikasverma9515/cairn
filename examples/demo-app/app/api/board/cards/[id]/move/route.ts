import { NextResponse } from "next/server";
import { moveCard } from "../../../../../../lib/board";

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const body = (await request.json()) as { toColumnId?: string };
  if (!body.toColumnId) return NextResponse.json({ error: "toColumnId is required" }, { status: 400 });
  const card = moveCard(params.id, body.toColumnId);
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(card);
}

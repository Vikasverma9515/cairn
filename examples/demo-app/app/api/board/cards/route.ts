import { NextResponse } from "next/server";
import { createCard } from "../../../../lib/board";

export async function POST(request: Request) {
  const body = (await request.json()) as { columnId?: string; title?: string };
  if (!body.columnId || !body.title) return NextResponse.json({ error: "columnId and title are required" }, { status: 400 });
  const card = createCard(body.columnId, body.title);
  return NextResponse.json(card, { status: 201 });
}

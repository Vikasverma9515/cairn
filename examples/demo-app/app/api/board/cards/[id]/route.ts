import { NextResponse } from "next/server";
import { updateCard } from "../../../../../lib/board";

export async function PATCH(request: Request, { params }: { params: { id: string } }) {
  const body = (await request.json()) as { title?: string; description?: string };
  const card = updateCard(params.id, body);
  if (!card) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(card);
}

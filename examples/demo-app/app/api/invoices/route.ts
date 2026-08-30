import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json({ id: `inv-${Date.now()}`, status: "created" }, { status: 201 });
}

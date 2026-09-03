import { NextResponse } from "next/server";
import { runTest } from "../../../../lib/workflows";

export async function POST() {
  return NextResponse.json(runTest());
}

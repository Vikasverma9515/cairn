import { NextResponse } from "next/server";
import { listBoard } from "../../../lib/board";

// GET for @cairnvibe/evals — the kanban/modal primitives' observePath.
export async function GET() {
  return NextResponse.json(listBoard());
}

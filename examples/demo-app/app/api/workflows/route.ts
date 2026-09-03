import { NextResponse } from "next/server";
import { getWorkflow } from "../../../lib/workflows";

export async function GET() {
  return NextResponse.json(getWorkflow());
}

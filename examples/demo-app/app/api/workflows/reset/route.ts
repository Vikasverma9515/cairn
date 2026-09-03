// Test-utility endpoint for @cairnvibe/evals to reset the playground's
// workflow state between scenario runs — this demo app is a dev/eval
// fixture, not a production deployment, so an unauthenticated reset is
// fine here; a real app would never ship this.
import { NextResponse } from "next/server";
import { resetWorkflow } from "../../../../lib/workflows";

export async function POST() {
  resetWorkflow();
  return NextResponse.json({ ok: true });
}

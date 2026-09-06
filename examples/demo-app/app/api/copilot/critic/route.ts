import { NextResponse } from "next/server";
import { createCriticHandlerWithLLM } from "@cairnvibe/sdk/server";
import { criticLLM } from "../../../../lib/groq-llm";

// criticLLM is a module-scope singleton (lib/groq-llm.ts) — see
// /api/copilot/route.ts's own comment for why: this route has no
// manifest to hot-reload at all, so the handler itself is built once
// here too, same established pattern speak/route.ts's own handler
// already uses.
const handler = createCriticHandlerWithLLM(criticLLM);

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

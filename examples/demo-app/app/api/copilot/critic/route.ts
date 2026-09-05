import { NextResponse } from "next/server";
import { createCriticHandler } from "@cairnvibe/sdk/server";

export async function POST(request: Request) {
  const handler = createCriticHandler({
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
  });

  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

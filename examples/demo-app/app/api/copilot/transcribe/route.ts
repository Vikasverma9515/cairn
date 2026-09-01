import { NextResponse } from "next/server";
import { createTranscribeHandler } from "@cairnvibe/sdk/transcribe-server";

const handler = createTranscribeHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "audio/webm";
  const buffer = await request.arrayBuffer();
  const result = await handler(buffer, contentType);
  return NextResponse.json(result.body, { status: result.status });
}

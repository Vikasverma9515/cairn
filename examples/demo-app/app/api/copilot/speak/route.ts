import { createSpeakHandler } from "@cairn/sdk/speak-server";

const handler = createSpeakHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

export async function POST(request: Request) {
  const { text } = await request.json().catch(() => ({ text: "" }));
  const result = await handler(text ?? "");

  if ("error" in result.body) {
    return Response.json(result.body, { status: result.status });
  }
  return new Response(result.body.audio, {
    status: result.status,
    headers: { "content-type": result.body.contentType },
  });
}

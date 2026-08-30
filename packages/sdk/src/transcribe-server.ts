// Server-side voice transcription for the Copilot widget's mic button (see
// `transcribeEndpoint` in index.tsx). The Deepgram key must never reach the
// client, so this is a plain fetch to Deepgram's prerecorded-transcription
// REST endpoint — no SDK dependency needed for one request shape.

const DEEPGRAM_URL = "https://api.deepgram.com/v1/listen";
// Verified against Deepgram's docs while building this — re-check if this
// starts erroring, model names retire over time.
const DEEPGRAM_DEFAULT_MODEL = "nova-2";

export interface CreateTranscribeHandlerOptions {
  apiKey: string;
  model?: string;
}

export interface TranscribeResult {
  status: number;
  body: { text: string } | { error: string };
}

export type TranscribeHandler = (audio: ArrayBuffer | Uint8Array, contentType: string) => Promise<TranscribeResult>;

export function createTranscribeHandler(options: CreateTranscribeHandlerOptions): TranscribeHandler {
  const model = options.model ?? process.env.DEEPGRAM_MODEL ?? DEEPGRAM_DEFAULT_MODEL;

  return async function handleTranscribe(audio, contentType) {
    if (!audio || (audio instanceof ArrayBuffer ? audio.byteLength === 0 : audio.length === 0)) {
      return { status: 400, body: { error: "no audio provided" } };
    }

    let response: Response;
    try {
      response = await fetch(`${DEEPGRAM_URL}?model=${encodeURIComponent(model)}&smart_format=true`, {
        method: "POST",
        headers: {
          Authorization: `Token ${options.apiKey}`,
          "content-type": contentType || "audio/webm",
        },
        // Buffer/Uint8Array is a valid fetch body at runtime; the DOM lib's
        // BodyInit type just doesn't line up with Node's typed-array generics here.
        body: audio as BodyInit,
      });
    } catch (err) {
      console.error("[cairn] transcription request failed:", err);
      return { status: 200, body: { error: "transcription service unreachable" } };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[cairn] Deepgram returned an error:", response.status, detail);
      return { status: 200, body: { error: "transcription failed" } };
    }

    const data = (await response.json()) as DeepgramResponse;
    const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript;
    if (typeof text !== "string") {
      return { status: 200, body: { error: "no transcript in response" } };
    }

    return { status: 200, body: { text } };
  };
}

interface DeepgramResponse {
  results?: {
    channels?: { alternatives?: { transcript?: string }[] }[];
  };
}

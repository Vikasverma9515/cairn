// Server-side text-to-speech for the Copilot widget's spoken answers (see
// `speakEndpoint` in index.tsx). The Deepgram key must never reach the
// client, so this is a plain fetch to Deepgram's /v1/speak REST endpoint —
// no SDK dependency needed for one request shape.

const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
// Verified against Deepgram's docs while building this — re-check if this
// starts erroring, voice model names retire over time.
const DEEPGRAM_DEFAULT_VOICE = "aura-2-thalia-en";

export interface CreateSpeakHandlerOptions {
  apiKey: string;
  model?: string;
}

export interface SpeakResult {
  status: number;
  /** `audio` is raw MP3 bytes on success. */
  body: { audio: ArrayBuffer; contentType: string } | { error: string };
}

export type SpeakHandler = (text: string) => Promise<SpeakResult>;

export function createSpeakHandler(options: CreateSpeakHandlerOptions): SpeakHandler {
  const model = options.model ?? process.env.DEEPGRAM_VOICE ?? DEEPGRAM_DEFAULT_VOICE;

  return async function handleSpeak(text: string) {
    if (!text || !text.trim()) {
      return { status: 400, body: { error: "no text provided" } };
    }

    let response: Response;
    try {
      response = await fetch(`${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(model)}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ text }),
      });
    } catch (err) {
      console.error("[cairn] speak request failed:", err);
      return { status: 200, body: { error: "speech service unreachable" } };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[cairn] Deepgram speak returned an error:", response.status, detail);
      return { status: 200, body: { error: "speech synthesis failed" } };
    }

    const audio = await response.arrayBuffer();
    return { status: 200, body: { audio, contentType: response.headers.get("content-type") ?? "audio/mpeg" } };
  };
}

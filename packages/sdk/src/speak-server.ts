// Server-side text-to-speech for the Copilot widget's spoken answers (see
// `speakEndpoint` in index.tsx). The Deepgram key must never reach the
// client.
//
// This used to be one fetch to Deepgram's /v1/speak REST endpoint, buffered
// into an ArrayBuffer with `await response.arrayBuffer()` before returning
// anything. That's the exact same bug the realtime path already fixed once
// (see tts-stream.ts's own comment): nothing plays until Deepgram renders
// AND the network delivers the *entire* reply, which measured 5-8s for a
// normal explain answer in real production logs. It also hit Deepgram's
// REST-only 2000-character cap on longer replies with no handling at all.
//
// Fixed the same way the realtime path was: open the streaming Speak
// WebSocket (tts-stream.ts's DeepgramSpeakStream, the same class the
// realtime server already uses) and forward audio chunks to the caller as
// they arrive, via a ReadableStream — not buffered. The route handler
// forwards that stream straight through as the HTTP response body, and the
// client (index.tsx) reads it progressively instead of awaiting a full
// Blob, so playback can start on the first chunk. Splitting the text into
// sentence-sized `Speak` messages before one `Flush` sidesteps the old
// 2000-char REST limit entirely (it doesn't apply to the WS protocol) and
// lets Deepgram start rendering the first sentence sooner.
import { DeepgramSpeakStream, type DeepgramSpeakStreamOptions, type SpeakChunkCallback } from "./tts-stream";

const DEEPGRAM_DEFAULT_VOICE = "aura-2-thalia-en";
// Matches the realtime path's own playback sample rate (index.tsx's
// audio_chunk handling defaults to 24000 too) — keeping them identical lets
// both paths share one raw-PCM16 decode/schedule routine on the client.
const SAMPLE_RATE = 24000;
// Not a protocol limit (the WS Speak protocol has none like REST's 2000
// chars) — just keeps each queued chunk sentence-sized so Deepgram can start
// rendering the first one quickly instead of parsing one giant message.
const MAX_CHUNK_CHARS = 300;

export interface CreateSpeakHandlerOptions {
  apiKey: string;
  model?: string;
}

export interface SpeakResult {
  status: number;
  /** `stream` yields raw linear16 PCM chunks (mono, 24kHz) as Deepgram
   * renders them — forward it directly, unbuffered; do not await it into a
   * Blob/ArrayBuffer or the whole point of streaming is lost. */
  body: { stream: ReadableStream<Uint8Array>; contentType: string } | { error: string };
}

export type SpeakHandler = (text: string) => Promise<SpeakResult>;

/** Test-only seam: lets tests inject a fake stream instead of opening a real
 * Deepgram WebSocket. Not part of CreateSpeakHandlerOptions on purpose — real
 * call sites (the scaffolded route templates) never pass this. */
export type SpeakStreamFactory = (
  opts: DeepgramSpeakStreamOptions,
  onAudioChunk: SpeakChunkCallback,
  handlers?: { onFlushed?: (sequenceId: number) => void; onError?: (err: Error) => void },
) => DeepgramSpeakStream;

function splitIntoChunks(text: string, maxChars: number): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > maxChars) {
      chunks.push(current);
      current = "";
    }
    current += sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}

export function createSpeakHandler(
  options: CreateSpeakHandlerOptions,
  streamFactory: SpeakStreamFactory = (opts, onAudioChunk, handlers) => new DeepgramSpeakStream(opts, onAudioChunk, handlers),
): SpeakHandler {
  const model = options.model ?? process.env.DEEPGRAM_VOICE ?? DEEPGRAM_DEFAULT_VOICE;

  return async function handleSpeak(text: string) {
    if (!text || !text.trim()) {
      return { status: 400, body: { error: "no text provided" } };
    }

    let enqueue: ((chunk: Uint8Array) => void) | null = null;
    let closeOut: (() => void) | null = null;
    let failOut: ((err: Error) => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (chunk) => controller.enqueue(chunk);
        closeOut = () => controller.close();
        failOut = (err) => controller.error(err);
      },
    });

    // True once connect() below resolves — an onError before that point is
    // already reported through connect()'s own rejection, so it's ignored
    // here to avoid double-handling the same failure.
    let connected = false;

    const speakStream = streamFactory(
      { apiKey: options.apiKey, model, encoding: "linear16", sampleRate: SAMPLE_RATE },
      (chunk) => enqueue?.(new Uint8Array(chunk)),
      {
        onFlushed: () => {
          closeOut?.();
          speakStream.close();
        },
        onError: (err) => {
          if (!connected) return;
          console.error("[cairn] speak stream error:", err);
          failOut?.(err);
        },
      },
    );

    try {
      await speakStream.connect();
    } catch (err) {
      console.error("[cairn] speak request failed:", err);
      return { status: 200, body: { error: "speech service unreachable" } };
    }
    connected = true;

    for (const chunk of splitIntoChunks(text, MAX_CHUNK_CHARS)) {
      speakStream.sendText(chunk);
    }
    speakStream.flush();

    return { status: 200, body: { stream, contentType: `audio/L16;rate=${SAMPLE_RATE}` } };
  };
}

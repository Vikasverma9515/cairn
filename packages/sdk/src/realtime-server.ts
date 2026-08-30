// A real-time voice relay: browser <-> this server <-> Deepgram live STT,
// resolving a verb (via the same core the HTTP handler uses) on every
// finalized utterance, then streaming synthesized speech back as it's
// rendered — not after it's fully rendered.
//
// Runs as its OWN process (via realtime-cli.ts / `cairn-realtime`), separate
// from the consumer's Next.js server — a plain WebSocket relay, nothing
// Next-specific about it. The Deepgram API key never leaves this process.
//
// Verified live before building this: a Node script opened
// wss://api.deepgram.com/v1/listen with a plain (non-scoped) API key,
// streamed real 16kHz PCM audio, and got back interim + final transcripts.
// True client-to-Deepgram streaming needs a short-lived scoped key this
// account can't mint (no keys:write scope) — this relay sidesteps that
// entirely by keeping the real key server-side, which is the more secure
// shape anyway.
//
// TTS is Deepgram's streaming Speak WebSocket (see tts-stream.ts), not the
// one-shot REST /v1/speak call this used to be — that REST call forced
// waiting for an entire MP3 to render AND download before playing a single
// byte, which was the actual cause of "the agent takes 5-10s to speak." One
// connection is opened per client and reused for every turn in the session
// (a fresh handshake per turn costs a real, measurable chunk of that latency
// on its own). Pattern verified against a real, working implementation of
// exactly this shape (a prior voice-agent project of the author's, VOXERA —
// its lib/deepgram/tts-stream.ts and server.ts) before building this.

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Manifest, VerbResponse } from "@cairn/core";
import { buildSystemPrompt, createVerbLLM, resolveVerb, type CapabilityTier, type CreateCopilotHandlerOptions } from "./server";
import { DeepgramSpeakStream } from "./tts-stream";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_STT_MODEL = "nova-2";
const DEFAULT_TTS_VOICE = "aura-2-thalia-en";
// Not constrained by any telephony 8kHz requirement — this is just "what
// quality does Deepgram render at" for browser playback, and the Web Audio
// API resamples an AudioBuffer at any declared rate transparently.
const TTS_SAMPLE_RATE = 24000;

export interface CreateRealtimeServerOptions extends CreateCopilotHandlerOptions {
  manifest: Manifest;
  deepgramApiKey: string;
  sttModel?: string;
  ttsVoice?: string;
}

type ServerMessage =
  | { type: "interim"; text: string }
  | { type: "final"; text: string }
  | { type: "verb"; verb: VerbResponse }
  | { type: "speaking_start" }
  /** One chunk of raw linear16 PCM audio, base64-encoded, as it's rendered — never the whole clip at once. */
  | { type: "audio_chunk"; audio: string; sampleRate: number }
  /** No more audio chunks are coming for this turn. The client may still be mid-playback of what it already has. */
  | { type: "speaking_end" }
  | { type: "turn_complete" }
  | { type: "error"; message: string };

export function createRealtimeServer(options: CreateRealtimeServerOptions): http.Server {
  const registeredActions = options.registeredActions ?? [];
  const capability = options.capability ?? "act";
  const llm = createVerbLLM(options);
  // "text" is optional on highlight/open/navigate/do in the base prompt —
  // fine for the typed/HTTP path, which always has a visible answer area,
  // but silence reads as broken in a live voice conversation (the client
  // still recovers correctly either way, via turn_complete below). The
  // instruction asks for a confirmation grounded in what was actually
  // done, not filler — generic phrasing here is what made replies feel
  // "unrelated" to the question that was just asked.
  const systemPrompt =
    buildSystemPrompt(options.manifest, registeredActions, options.persona) +
    `\n\nYou are in a live voice conversation right now — the user is speaking out loud and may not be looking at the screen. For highlight/open/navigate/do, include a short spoken "text" that names the specific thing you're pointing at or the specific place you're sending them (e.g. "Highlighting the New Invoice button" or "Taking you to Invoices"), not a generic filler phrase — so they hear a confirmation that's actually about their question.`;
  const sttModel = options.sttModel ?? process.env.DEEPGRAM_MODEL ?? DEFAULT_STT_MODEL;
  const ttsVoice = options.ttsVoice ?? process.env.DEEPGRAM_VOICE ?? DEFAULT_TTS_VOICE;
  const deepgramApiKey = options.deepgramApiKey;

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cairn realtime relay\n");
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (client) => {
    handleConnection(client, { deepgramApiKey, sttModel, ttsVoice, llm, systemPrompt, registeredActions, capability }).catch(
      (err) => {
        console.error("[cairn realtime] connection error:", err);
        safeSend(client, { type: "error", message: "internal error" });
        client.close();
      },
    );
  });

  return httpServer;
}

interface ConnectionDeps {
  deepgramApiKey: string;
  sttModel: string;
  ttsVoice: string;
  llm: ReturnType<typeof createVerbLLM>;
  systemPrompt: string;
  registeredActions: string[];
  capability: CapabilityTier;
}

async function handleConnection(client: WebSocket, deps: ConnectionDeps): Promise<void> {
  let context = { route: "/", visible: [] as string[] };

  const dgUrl =
    `${DEEPGRAM_LIVE_URL}?model=${encodeURIComponent(deps.sttModel)}` +
    `&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000`;
  const dg = new WebSocket(dgUrl, { headers: { Authorization: `Token ${deps.deepgramApiKey}` } });

  let dgOpen = false;
  const pendingAudio: Buffer[] = [];

  dg.on("open", () => {
    dgOpen = true;
    for (const chunk of pendingAudio.splice(0)) dg.send(chunk);
  });

  // ONE Speak connection reused for every turn in this session — a fresh
  // handshake per turn is a real, measurable chunk of the latency this
  // rewrite exists to remove. Recreated on demand if it ever drops.
  let speakStream: DeepgramSpeakStream | null = null;
  let speakStreamReady: Promise<void> | null = null;
  // Resolves the in-flight speakStreamed() call for the current turn once
  // Deepgram confirms (via "Flushed") that every chunk for this turn's
  // Flush has actually been sent — the real "no more audio coming" signal,
  // not a fixed timeout. Bound once at stream creation (Deepgram fires one
  // Flushed per Flush call), rebound per-turn as each new call starts.
  let onCurrentTurnFlushed: (() => void) | null = null;

  function ensureSpeakStream(): { stream: DeepgramSpeakStream; ready: Promise<void> } {
    if (!speakStream) {
      const stream = new DeepgramSpeakStream(
        { apiKey: deps.deepgramApiKey, model: deps.ttsVoice, encoding: "linear16", sampleRate: TTS_SAMPLE_RATE },
        () => {}, // rebound per-turn via setAudioHandler before each use
        { onFlushed: () => onCurrentTurnFlushed?.() },
      );
      speakStream = stream;
      speakStreamReady = stream.connect().catch((err) => {
        console.error("[cairn realtime] Speak stream connect failed:", err);
        speakStream = null;
        speakStreamReady = null;
      });
    }
    return { stream: speakStream, ready: speakStreamReady! };
  }

  async function speakStreamed(text: string): Promise<void> {
    const { stream, ready } = ensureSpeakStream();

    stream.setAudioHandler((chunk) => {
      safeSend(client, { type: "audio_chunk", audio: chunk.toString("base64"), sampleRate: TTS_SAMPLE_RATE });
    });

    await ready;
    if (!speakStream) {
      // Reconnect failed — degrade to turn_complete rather than hanging the client.
      safeSend(client, { type: "turn_complete" });
      return;
    }

    await new Promise<void>((resolve) => {
      onCurrentTurnFlushed = () => {
        onCurrentTurnFlushed = null;
        safeSend(client, { type: "speaking_end" });
        resolve();
      };
      safeSend(client, { type: "speaking_start" });
      stream.sendText(text);
      stream.flush();
    });
  }

  dg.on("message", (data) => {
    void handleDeepgramMessage(data.toString(), client, deps, () => context, speakStreamed);
  });

  dg.on("error", (err) => {
    console.error("[cairn realtime] Deepgram STT connection error:", err);
    safeSend(client, { type: "error", message: "speech recognition unavailable" });
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (dgOpen) dg.send(buf);
      else pendingAudio.push(buf);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "context") {
        context = { route: String(msg.route ?? "/"), visible: Array.isArray(msg.visible) ? msg.visible : [] };
      } else if (msg.type === "end") {
        client.close();
      }
    } catch {
      // Ignore malformed control messages — never crash the relay on bad client input.
    }
  });

  client.on("close", () => {
    try {
      dg.close();
    } catch {
      // already closed
    }
    speakStream?.close();
  });
}

async function handleDeepgramMessage(
  raw: string,
  client: WebSocket,
  deps: ConnectionDeps,
  getContext: () => { route: string; visible: string[] },
  speakStreamed: (text: string) => Promise<void>,
): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type !== "Results") return;
  const transcript: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
  if (!transcript) return;

  if (!msg.is_final) {
    safeSend(client, { type: "interim", text: transcript });
    return;
  }

  safeSend(client, { type: "final", text: transcript });

  const { route, visible } = getContext();
  const verb = await resolveVerb(deps.llm, deps.systemPrompt, deps.registeredActions, deps.capability, {
    route,
    question: transcript,
    visible,
  });
  // Sent immediately — before speech synthesis even starts — so
  // highlight/navigate/do execute in the browser right away instead of
  // waiting on audio. The agent visibly acts while it's still about to
  // speak, not after.
  safeSend(client, { type: "verb", verb });

  // A verb with no spoken text (highlight/navigate/do often have none)
  // still needs to unstick the client's "thinking" state and let the mic
  // resume — turn_complete covers that with no audio path involved.
  if ("text" in verb && verb.text) {
    await speakStreamed(verb.text);
  } else {
    safeSend(client, { type: "turn_complete" });
  }
}

function safeSend(client: WebSocket, message: ServerMessage): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify(message));
}

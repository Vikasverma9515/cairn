// A real-time voice relay: browser <-> this server <-> Deepgram live STT,
// resolving a verb (via the same core the HTTP handler uses) on every
// finalized utterance, then synthesizing and streaming back speech.
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

import http from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Manifest, VerbResponse } from "@cairn/core";
import { buildSystemPrompt, createVerbLLM, resolveVerb, type CreateCopilotHandlerOptions } from "./server";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";
const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const DEFAULT_STT_MODEL = "nova-2";
const DEFAULT_TTS_VOICE = "aura-2-thalia-en";

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
  | { type: "speaking_end" }
  | { type: "turn_complete" }
  | { type: "error"; message: string };

export function createRealtimeServer(options: CreateRealtimeServerOptions): http.Server {
  const registeredActions = options.registeredActions ?? [];
  const llm = createVerbLLM(options);
  // "text" is optional on highlight/open/navigate/do in the base prompt —
  // fine for the typed/HTTP path, which always has a visible answer area,
  // but silence reads as broken in a live voice conversation (the client
  // still recovers correctly either way, via turn_complete below).
  const systemPrompt =
    buildSystemPrompt(options.manifest, registeredActions) +
    `\n\nYou are in a live voice conversation right now — the user is speaking out loud and may not be looking at the screen. Always include a short spoken "text" in your response, even for highlight/open/navigate/do (e.g. "Here it is" or "Taking you to Invoices now"), so they hear a confirmation instead of silence.`;
  const sttModel = options.sttModel ?? process.env.DEEPGRAM_MODEL ?? DEFAULT_STT_MODEL;
  const ttsVoice = options.ttsVoice ?? process.env.DEEPGRAM_VOICE ?? DEFAULT_TTS_VOICE;
  const deepgramApiKey = options.deepgramApiKey;

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cairn realtime relay\n");
  });
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (client) => {
    handleConnection(client, { deepgramApiKey, sttModel, ttsVoice, llm, systemPrompt, registeredActions }).catch(
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

  dg.on("message", (data) => {
    void handleDeepgramMessage(data.toString(), client, deps, () => context);
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
  });
}

async function handleDeepgramMessage(
  raw: string,
  client: WebSocket,
  deps: ConnectionDeps,
  getContext: () => { route: string; visible: string[] },
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
  const verb = await resolveVerb(deps.llm, deps.systemPrompt, deps.registeredActions, {
    route,
    question: transcript,
    visible,
  });
  safeSend(client, { type: "verb", verb });

  // The client only resumes listening (and only resumes sending mic audio —
  // see the "listening"-only send guard client-side) once it hears the turn
  // is over. A verb with no spoken text (highlight/navigate/do often have
  // none) used to leave it stuck on "thinking" forever, with a dead mic,
  // since only speaking_end used to signal that. turn_complete covers the
  // no-speech case explicitly.
  if ("text" in verb && verb.text) {
    await speakAndSend(client, verb.text, deps);
  } else {
    safeSend(client, { type: "turn_complete" });
  }
}

async function speakAndSend(client: WebSocket, text: string, deps: ConnectionDeps): Promise<void> {
  try {
    const response = await fetch(`${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(deps.ttsVoice)}`, {
      method: "POST",
      headers: { Authorization: `Token ${deps.deepgramApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.error("[cairn realtime] Deepgram speak error:", response.status, await response.text().catch(() => ""));
      return;
    }
    const audio = Buffer.from(await response.arrayBuffer());
    safeSend(client, { type: "speaking_start" });
    if (client.readyState === WebSocket.OPEN) client.send(audio);
    safeSend(client, { type: "speaking_end" });
  } catch (err) {
    console.error("[cairn realtime] speech synthesis failed:", err);
  }
}

function safeSend(client: WebSocket, message: ServerMessage): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify(message));
}

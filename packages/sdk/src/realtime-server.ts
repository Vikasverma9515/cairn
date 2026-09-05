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
import type { AgentEvent, HistoryTurn, LiveElement, Manifest, Plan, ProgressLedger, VerbResponse, WebMcpTool } from "@cairnvibe/core";
import { driveAgentLoop, looksMultiStep, MAX_HISTORY_TURNS, summarizeVerbForHistory } from "./agent-loop";
import {
  buildSystemPrompt,
  createCriticLLM,
  createPlanLLM,
  createVerbLLM,
  fallbackPlan,
  renderRegisteredActions,
  resolveCritic,
  resolvePlan,
  resolveVerb,
  type CapabilityTier,
  type CreateCopilotHandlerOptions,
} from "./server";
import { DeepgramSpeakStream } from "./tts-stream";
import { formatRememberedFacts, seedHistoryFromMemory, type MemoryStore } from "./memory-sqlite";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_STT_MODEL = "nova-2";
const DEFAULT_TTS_VOICE = "aura-2-thalia-en";
// The Talker half of a Talker/Reasoner split (see finalizeTurn): spoken the
// instant a turn turns out to need more than one step, so the user hears
// something within about a second instead of dead air while the real
// multi-step work runs. A short rotating set, not one fixed line, so it
// doesn't read as a canned bot phrase on every multi-step question.
//
// Phase 2 step 3 — rewritten from the original set (kept below in spirit
// but not verbatim: "Let me check that for you." / "One moment, let me
// look into that." / "Give me a second to check." / "Let me take a
// look.") for two real, testable reasons, not a vibe change: (1) the
// plan's own bar is "feels like a person coordinating a team ('give me
// a sec, sorting that out'), never generic-corporate" — the original
// set's formal, service-desk phrasing ("One moment, let me look into
// that") is closer to a phone-tree script than a coworker; (2) "kept
// short on purpose (a long ack costs real latency budget)" — the
// original set averaged 6 words; this one averages under 4, a real,
// measurable reduction in synthesis time before the ack is even
// audible, on top of sounding more like a person. Graded on this now,
// not eyeballed — see judge.ts's new `persona` dimension and
// realtime-server.ts's own "ack" message, which exposes the actual
// spoken text to packages/evals' trace capture for the first time.
const ACK_PHRASES = ["Give me a sec.", "One sec, checking.", "Hang on, let me look.", "On it, one sec.", "Just a sec here.", "Let me check real quick."];
// Not constrained by any telephony 8kHz requirement — this is just "what
// quality does Deepgram render at" for browser playback, and the Web Audio
// API resamples an AudioBuffer at any declared rate transparently.
const TTS_SAMPLE_RATE = 24000;

/**
 * Phase 5 step 2 — explicit fact-remembering (Track B's own "remember is
 * an explicit act, never automatic" pattern — step 1 built the automatic
 * turn-recording half; this is the deliberate half). Modeled as a
 * SYNTHETIC WebMCP tool the model can call_tool, not a new verb — reuses
 * the existing call_tool grammar/validation the model already knows
 * ("a tool name from this turn's webMcpTools list") instead of inventing
 * a new one. Handled entirely SERVER-SIDE (see executeStep below) —
 * the client never learns this step happened at all (see onStep below
 * for why that's not just an optimization: it's what keeps this safe).
 */
const REMEMBER_FACT_TOOL_NAME = "remember_fact";
const REMEMBER_FACT_TOOL: WebMcpTool = {
  name: REMEMBER_FACT_TOOL_NAME,
  description:
    "Remember something worth recalling in a FUTURE conversation with this same user — a stated preference, a known pitfall, anything that would help next time. Not for facts only relevant to answering right now. Call this AT MOST ONCE per turn, for one real fact. Once it returns, the fact is already saved — immediately give your final spoken answer (e.g. explain) confirming that to the user; do not call this again in the same turn.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "A short, stable name for this fact, e.g. \"preferredUnits\" or \"flakySelectorNote\"." },
      value: { type: "string", description: "The real fact to remember, in plain language." },
    },
    required: ["key", "value"],
  },
};

async function handleRememberFactTool(memory: MemoryStore, scopeId: string, args: Record<string, unknown> | undefined): Promise<string> {
  const key = typeof args?.key === "string" ? args.key.trim() : "";
  const value = typeof args?.value === "string" ? args.value.trim() : "";
  if (!key || !value) return "Could not remember that — a key and a value are both required.";
  memory.rememberFact(scopeId, key, value);
  return `Remembered: ${key} = ${value}`;
}

export interface CreateRealtimeServerOptions extends CreateCopilotHandlerOptions {
  manifest: Manifest;
  deepgramApiKey: string;
  sttModel?: string;
  ttsVoice?: string;
  /** Phase 5 — real cross-session memory (packages/sdk/src/memory-sqlite.ts,
   * or any store implementing the same interface). Optional — omitting it
   * keeps every connection exactly as memory-less as before this existed.
   * Scoped by whatever `scopeId` string a connection's own client sends in
   * its "context" message (see ConnectionDeps' own doc comment) — this SDK
   * invents no identity of its own. */
  memory?: MemoryStore;
}

type ServerMessage =
  | { type: "interim"; text: string }
  /** `generation` (and on every other message below that carries one) is
   * the server's own barge-in generation counter at the moment THIS
   * message was produced — see `triggerServerBargeIn`'s `generation`
   * variable. Real, live-found bug this closes: the client's own local
   * barge-in (VAD-triggered, entirely independent of the server) can
   * start a brand-new turn's "final" before an EARLIER turn's own verb/
   * audio — already in flight on the wire when the server processed the
   * barge-in — actually arrives. WebSocket delivers messages in order,
   * but "in order" isn't "still relevant": without a way to tell an
   * older turn's message apart from the current one, the client applied
   * it anyway, misattributing a stale answer to whatever question was
   * now current — the exact "one question, but a different, unrelated-
   * sounding answer showed up later" bug found live. The client tracks
   * the generation of the most recent "final" it's processed and drops
   * any later verb/speaking/audio message whose generation is older. */
  | { type: "final"; text: string; generation: number }
  | { type: "verb"; verb: VerbResponse; generation: number }
  | { type: "speaking_start"; generation: number }
  /** One chunk of raw linear16 PCM audio, base64-encoded, as it's rendered — never the whole clip at once. */
  | { type: "audio_chunk"; audio: string; sampleRate: number; generation: number }
  /** No more audio chunks are coming for this turn. The client may still be mid-playback of what it already has. */
  | { type: "speaking_end"; generation: number }
  | { type: "turn_complete"; generation: number }
  /** Phase 2 step 3 — the ack phrase's text, sent alongside the audio
   * that speaks it. Purely informational (see emitEvent's own "inj"
   * case) — mainly so packages/evals' voiceFrames capture has something
   * readable to grade the Talker's persona against. */
  | { type: "ack"; text: string }
  | { type: "error"; message: string };

// seedHistoryFromMemory/formatRememberedFacts moved to memory-sqlite.ts
// (Phase 5 step 4) — the SAME shared, storage-agnostic logic both the
// realtime relay and the typed/HTTP transport need. Re-exported here
// (not just imported) so every existing import from "./realtime-server"
// keeps working unchanged.
export { seedHistoryFromMemory, formatRememberedFacts };

export function createRealtimeServer(options: CreateRealtimeServerOptions): http.Server {
  const registeredActions = options.registeredActions ?? [];
  const capability = options.capability ?? "act";
  const llm = createVerbLLM(options);
  // Phase 3 steps 2-3 — real, separately-configured Planner/Critic LLMs.
  // See finalizeTurn's own doc comment for how they're actually used.
  const planLLM = createPlanLLM(options);
  const criticLLM = createCriticLLM(options);
  // "text" is optional on highlight/open/navigate/do in the base prompt —
  // fine for the typed/HTTP path, which always has a visible answer area,
  // but silence reads as broken in a live voice conversation (the client
  // still recovers correctly either way, via turn_complete below). The
  // instruction asks for a confirmation grounded in what was actually
  // done, not filler — generic phrasing here is what made replies feel
  // "unrelated" to the question that was just asked.
  const actionDescriptions = options.actionDescriptions ?? {};
  const systemPrompt =
    buildSystemPrompt(options.manifest, registeredActions, options.persona, actionDescriptions) +
    `\n\nYou are in a live voice conversation right now — the user is speaking out loud and may not be looking at the screen. For highlight/open/navigate/do, include a short spoken "text" that names the specific thing you're pointing at or the specific place you're sending them (e.g. "Highlighting the New Invoice button" or "Taking you to Invoices"), not a generic filler phrase — so they hear a confirmation that's actually about their question.`;
  const sttModel = options.sttModel ?? process.env.DEEPGRAM_MODEL ?? DEFAULT_STT_MODEL;
  const ttsVoice = options.ttsVoice ?? process.env.DEEPGRAM_VOICE ?? DEFAULT_TTS_VOICE;
  const deepgramApiKey = options.deepgramApiKey;

  const httpServer = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cairn realtime relay\n");
  });
  const wss = new WebSocketServer({ server: httpServer });

  // Real, server-side visibility into how many browser tabs/connections
  // are actually live at once — added specifically to answer, with real
  // data instead of a guess, a live-raised concern: could a page reload
  // (or several in quick succession) leave more than one realtime
  // connection open at the same time, each independently running its own
  // Deepgram STT/TTS and LLM calls for the same user? Every connection
  // gets a short id, logged on open and close, alongside a live count —
  // if that count is ever more than 1 during normal single-tab use, THAT
  // is the real, direct evidence of a genuine duplicate-connection bug;
  // if it always reads 1, duplication server-side is ruled out with real
  // proof, not assumed away.
  let nextConnectionId = 1;
  let activeConnections = 0;

  wss.on("connection", (client) => {
    const connectionId = nextConnectionId++;
    activeConnections++;
    console.log(`[cairn realtime] connection ${connectionId} opened — ${activeConnections} active`);
    client.on("close", () => {
      activeConnections--;
      console.log(`[cairn realtime] connection ${connectionId} closed — ${activeConnections} active`);
    });
    handleConnection(client, { deepgramApiKey, sttModel, ttsVoice, llm, planLLM, criticLLM, systemPrompt, manifest: options.manifest, registeredActions, actionDescriptions, capability, memory: options.memory }).catch(
      (err) => {
        console.error(`[cairn realtime] connection ${connectionId} error:`, err);
        safeSend(client, { type: "error", message: "internal error" });
        client.close();
      },
    );
  });

  return httpServer;
}

export interface ConnectionDeps {
  deepgramApiKey: string;
  sttModel: string;
  ttsVoice: string;
  llm: ReturnType<typeof createVerbLLM>;
  /** Phase 3 step 2 — a separately-configured Planner LLM, called on the
   * first continuing step of a turn (see finalizeTurn). Optional so
   * existing ConnectionDeps construction (and every existing test) keeps
   * working unchanged; absent means no Planner call happens at all. */
  planLLM?: ReturnType<typeof createPlanLLM>;
  /** Phase 3 step 3 — a separately-configured Critic LLM. Only engages
   * (task-advancement/replan/give-up actually driving the loop, not just
   * logging) when BOTH this and planLLM are present — the Critic needs a
   * real Plan's current task to check against. Optional for the same
   * backward-compatibility reason as planLLM. */
  criticLLM?: ReturnType<typeof createCriticLLM>;
  systemPrompt: string;
  manifest: Manifest;
  registeredActions: string[];
  /** Phase 4 step 4 — real descriptions for registeredActions ids, same
   * shape/purpose as CreateCopilotHandlerOptions.actionDescriptions.
   * Optional, defaults to {} — an existing ConnectionDeps construction
   * (own or a test's) keeps working with every action rendered bare. */
  actionDescriptions?: Record<string, string>;
  capability: CapabilityTier;
  /** Phase 5 — see CreateRealtimeServerOptions' own doc comment. Optional,
   * same backward-compatibility reason as every other addition here:
   * absent means no memory read/write happens for any connection, ever
   * — today's exact behavior. */
  memory?: MemoryStore;
}

async function handleConnection(client: WebSocket, deps: ConnectionDeps): Promise<void> {
  // liveElements/webMcpTools refresh on every "context" resend (the client
  // sends one on route changes and each time it's about to start listening
  // again), so a live scan from several turns ago never lingers into a
  // later one.
  let context: { route: string; visible: string[]; liveElements: LiveElement[]; webMcpTools: WebMcpTool[] } = {
    route: "/",
    visible: [],
    liveElements: [],
    webMcpTools: [],
  };
  // Unlike the stateless HTTP path (which needs the client to resend
  // history every request), a realtime connection is already stateful —
  // one WebSocket per call — so this is accumulated here directly rather
  // than round-tripped through the client.
  const history: HistoryTurn[] = [];
  // Phase 5 — real cross-session memory. `scopeId` is set from the FIRST
  // "context" message that carries one (see the "context" handler below)
  // and never changed again for the life of this connection — a real,
  // deliberate v1 simplification (no attempt to handle a scopeId that
  // legitimately changes mid-connection, e.g. a mid-session login) rather
  // than guessed-at complexity. `historySeededFromMemory` guards the
  // ONE-TIME load of this scope's prior turns into `history` — a later
  // "context" resend (route changes send fresh ones routinely) must never
  // re-seed and duplicate them.
  let scopeId: string | null = null;
  let historySeededFromMemory = false;
  function recordMemoryTurn(role: "user" | "assistant", text: string): void {
    if (!deps.memory || !scopeId) return;
    deps.memory.recordTurn(scopeId, role, text);
  }
  // Resolves the agent loop's in-flight waitForToolResult() call once the
  // client reports back what a click/fill/read/call_tool step actually
  // did — same "a mutable pending-callback slot, resolved when the right
  // message arrives" pattern onCurrentTurnFlushed already uses below.
  let pendingToolResultResolve: ((observation: string) => void) | null = null;

  const dgUrl =
    `${DEEPGRAM_LIVE_URL}?model=${encodeURIComponent(deps.sttModel)}` +
    `&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=300&utterance_end_ms=1000`;

  // Real, live-reported bug this closes: "status says Listening but nothing
  // happens" — the client keeps looking and sounding fine (mic still
  // capturing, WS still open, no error ever shown), because the REAL
  // failure is silent and one layer deeper: Deepgram's own STT connection
  // can close mid-session (an idle timeout, a network blip, Deepgram's own
  // connection lifetime limit) and this code never noticed — there was no
  // `dg.on("close", ...)` handler at all, `dgOpen` never got reset to
  // false, and every subsequent mic frame kept calling `dg.send(buf)` on an
  // already-CLOSED socket with no callback to catch the failure. The client
  // never heard about any of this, because nothing here ever sent it an
  // "error" message — from the outside it looks exactly like "listening,
  // but the mic just isn't picking anything up."
  //
  // Fixed by making the STT connection self-healing instead of a single
  // fire-and-forget WebSocket: `dg` is now reassignable, and a real close
  // triggers a bounded number of automatic reconnects (fresh handshake,
  // same handlers) before finally giving up and telling the client — so a
  // transient Deepgram-side drop recovers on its own instead of silently
  // bricking the rest of the call.
  let dg: WebSocket;
  let dgOpen = false;
  let dgReconnectAttempts = 0;
  const MAX_DG_RECONNECT_ATTEMPTS = 3;
  const pendingAudio: Buffer[] = [];
  // Accumulates Deepgram "Results" transcript segments across one utterance
  // — see handleDeepgramMessage for why this can't just react to every
  // is_final. Declared before connectDeepgramStt so its own "message"
  // handler closes over an already-initialized binding, not just a
  // same-scope one that happens to be safe only because WS events are
  // always async.
  const turnState = { buffer: "" };

  function connectDeepgramStt(): void {
    const socket = new WebSocket(dgUrl, { headers: { Authorization: `Token ${deps.deepgramApiKey}` } });
    dg = socket;

    socket.on("open", () => {
      dgOpen = true;
      dgReconnectAttempts = 0;
      for (const chunk of pendingAudio.splice(0)) socket.send(chunk);
    });

    socket.on("message", (data) => {
      void handleDeepgramMessage(data.toString(), client, deps, () => context, speakStreamed, history, turnState, () => generation, waitForToolResult, recordMemoryTurn, () => scopeId, () => {
        generation++;
      });
    });

    socket.on("error", (err) => {
      console.error("[cairn realtime] Deepgram STT connection error:", err);
    });

    socket.on("close", (code, reason) => {
      dgOpen = false;
      console.log(`[cairn realtime] Deepgram STT connection closed (code ${code}${reason ? `, ${reason}` : ""})`);
      if (client.readyState !== WebSocket.OPEN) return; // the whole call already ended — nothing to reconnect for
      if (dgReconnectAttempts >= MAX_DG_RECONNECT_ATTEMPTS) {
        console.error(`[cairn realtime] Deepgram STT gave up reconnecting after ${MAX_DG_RECONNECT_ATTEMPTS} attempts`);
        safeSend(client, { type: "error", message: "Speech recognition connection was lost and couldn't be restored — try starting the call again." });
        return;
      }
      dgReconnectAttempts++;
      console.log(`[cairn realtime] reconnecting to Deepgram STT (attempt ${dgReconnectAttempts}/${MAX_DG_RECONNECT_ATTEMPTS})`);
      connectDeepgramStt();
    });
  }

  connectDeepgramStt();

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
  // Bumped on barge-in — any audio_chunk/speaking_end belonging to an
  // earlier generation is dropped instead of sent, so a chunk that was
  // already in flight over the network when the user interrupted can't
  // sneak back in and resume playback after the client already moved on.
  let generation = 0;

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

  // A real, live-reported bug in what used to live here: a "confirm-or-
  // reverse" grace window that, on ANY barge-in with no confirming STT
  // transcript arriving within 600ms, concluded it was a false positive
  // and RE-SPOKE THE SAME TEXT FROM THE TOP. Live symptom, reported
  // directly: saying "stop" cut the agent off, paused for about a
  // second, then the exact same answer started playing again from the
  // beginning — because Deepgram's own transcript for "stop" routinely
  // arrived a little later than the 600ms window, so every clean,
  // deliberate interruption looked exactly like an unconfirmed false
  // alarm and got "resumed." Direct user instruction: there should be no
  // such system at all — a barge-in should behave like it does in any
  // normal voice assistant, an immediate, permanent stop, never a guess
  // at whether to talk over the user again. `triggerServerBargeIn` is
  // now exactly that: bump generation (drops any audio/verb already in
  // flight), clear the TTS stream, unstick a pending speakStreamed()
  // call — and nothing else.
  function triggerServerBargeIn(): void {
    generation++;
    speakStream?.clear();
    onCurrentTurnFlushed?.();
  }

  async function speakStreamed(text: string): Promise<void> {
    const myGeneration = generation;
    const { stream, ready } = ensureSpeakStream();

    stream.setAudioHandler((chunk) => {
      if (myGeneration !== generation) return; // stale — dropped by barge-in
      safeSend(client, { type: "audio_chunk", audio: chunk.toString("base64"), sampleRate: TTS_SAMPLE_RATE, generation: myGeneration });
    });

    await ready;
    if (!speakStream || myGeneration !== generation) {
      // Reconnect failed, or barge-in happened before the stream connected —
      // either way, only degrade to turn_complete if this is still current.
      if (myGeneration === generation) safeSend(client, { type: "turn_complete", generation: myGeneration });
      return;
    }

    await new Promise<void>((resolve) => {
      onCurrentTurnFlushed = () => {
        onCurrentTurnFlushed = null;
        if (myGeneration === generation) safeSend(client, { type: "speaking_end", generation: myGeneration });
        resolve();
      };
      safeSend(client, { type: "speaking_start", generation: myGeneration });
      stream.sendText(text);
      stream.flush();
    });
  }

  /**
   * Pauses the agent loop (finalizeTurn, below) until the client reports
   * back the real result of a click/fill/read/call_tool step it just sent
   * out — the server can't execute a DOM action itself, so every
   * continuing step needs a real round trip to the browser and back. A
   * real timeout, not a hang: a client that never answers (closed tab,
   * dropped connection) can't leave a turn stuck forever.
   */
  function waitForToolResult(): Promise<string> {
    return new Promise((resolve) => {
      pendingToolResultResolve = resolve;
      setTimeout(() => {
        if (pendingToolResultResolve === resolve) {
          pendingToolResultResolve = null;
          resolve("(no result — timed out waiting for the browser)");
        }
      }, 15000);
    });
  }

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      // The readyState check (not just dgOpen) is real, defensive belt-and-
      // suspenders: dgOpen is reset to false the instant "close" fires, but
      // a mic frame arriving in the same tick as a not-yet-processed close
      // event should never risk calling .send() on a socket that's already
      // gone — that used to be exactly how a dead connection kept silently
      // swallowing audio with no error ever surfacing.
      if (dgOpen && dg.readyState === WebSocket.OPEN) dg.send(buf);
      else pendingAudio.push(buf);
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "context") {
        context = {
          route: String(msg.route ?? "/"),
          visible: Array.isArray(msg.visible) ? msg.visible : [],
          liveElements: parseLiveElements(msg.liveElements),
          webMcpTools: parseWebMcpTools(msg.webMcpTools),
        };
        // Phase 5 — `scopeId` is whatever opaque id the CUSTOMER's own
        // client code chooses to send (their own end-user id if they have
        // login, anything else stable otherwise) — this SDK never invents
        // one. Only the first real scopeId this connection ever sees is
        // used; a later "context" resend's scopeId (route changes send
        // these routinely) is ignored, and the one-time prior-turn load
        // below never repeats.
        if (!scopeId && typeof msg.scopeId === "string" && msg.scopeId) {
          const newScopeId: string = msg.scopeId;
          scopeId = newScopeId;
          if (deps.memory && !historySeededFromMemory) {
            historySeededFromMemory = true;
            const priorTurns = deps.memory.recentTurns(newScopeId);
            const seeded = seedHistoryFromMemory(history, priorTurns, MAX_HISTORY_TURNS);
            history.length = 0;
            history.push(...seeded);

            // Prepended AFTER the cap above, deliberately exempt from
            // it — a remembered fact ("prefers metric units") should
            // stay in context for the WHOLE connection, not age out the
            // same way an ordinary conversation turn does once enough
            // new turns accumulate.
            const factsSummary = formatRememberedFacts(deps.memory.recallFacts(newScopeId));
            if (factsSummary) history.unshift({ role: "assistant", text: factsSummary });
          }
        }
      } else if (msg.type === "tool_result" && typeof msg.observation === "string") {
        // The client finished executing a click/fill/read/call_tool step
        // the agent loop sent it — this is what finalizeTurn's
        // waitForToolResult() below is paused on.
        pendingToolResultResolve?.(msg.observation);
        pendingToolResultResolve = null;
      } else if (msg.type === "end") {
        client.close();
      } else if (msg.type === "barge_in") {
        triggerServerBargeIn();
      } else if (msg.type === "speak" && typeof msg.text === "string" && msg.text.trim()) {
        // A "tour" step being narrated while a realtime session is already
        // open — reuses the exact same streaming Speak connection and
        // audio_chunk protocol as a conversational reply, instead of the
        // client falling back to a separate buffered REST call. No STT/verb
        // resolution involved; the client already resolved the tour steps
        // itself and just needs this text spoken.
        //
        // Caught explicitly, unlike a normal turn's speakStreamed call (see
        // handleDeepgramMessage) — this one isn't inside that function's own
        // try/catch, and an uncaught rejection here previously vanished
        // silently: the client's speakOverRealtime() promise for this step
        // never resolves except via its own 15s fallback timeout, with
        // nothing telling the user anything went wrong in the meantime —
        // found live as a tour that goes badly quiet for stretches at a
        // time. A real "error" message lets the client's tour-step handler
        // (index.tsx's ws.onmessage) unstick itself immediately instead.
        speakStreamed(msg.text).catch((err) => {
          console.error("[cairn realtime] speakStreamed failed for a tour step:", err);
          safeSend(client, { type: "error", message: "Something went wrong narrating that step." });
        });
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

export async function handleDeepgramMessage(
  raw: string,
  client: WebSocket,
  deps: ConnectionDeps,
  getContext: () => { route: string; visible: string[]; liveElements: LiveElement[]; webMcpTools: WebMcpTool[] },
  speakStreamed: (text: string) => Promise<void>,
  history: HistoryTurn[],
  turnState: { buffer: string },
  getGeneration: () => number,
  waitForToolResult: () => Promise<string>,
  /** Phase 5 — called with each real (role, text) turn as it's finalized,
   * right alongside the same-shaped `history.push`. Optional and a no-op
   * by default so every existing call site keeps working unchanged. The
   * realtime connection's own recordMemoryTurn writes it to durable
   * storage when memory + a scopeId are both configured for this
   * connection — see ConnectionDeps.memory's own doc comment. */
  recordMemoryTurn?: (role: "user" | "assistant", text: string) => void,
  /** Phase 5 step 2 — see finalizeTurn's own doc comment. Threaded
   * through here purely to reach finalizeTurn's two call sites below. */
  getScopeId?: () => string | null,
  /** Real, live-found gap this closes: `generation` (getGeneration/
   * triggerServerBargeIn) previously only ever bumped on an EXPLICIT
   * barge-in — two ordinary, sequential turns with no interruption
   * between them shared the exact same generation number. That was
   * fine for what `generation` was originally built for (dropping
   * audio/verbs abandoned mid-turn by a real interruption), but it
   * left the CLIENT's own generation-based staleness check (added for
   * that same reason, in index.tsx) with no way to tell a merely SLOW
   * turn's late-arriving reply apart from the current one — nothing
   * had bumped, so the late reply's generation still matched. Found
   * live: a "hello" reply that took long enough to arrive AFTER the
   * next question's own "final" had already fired, landing on the
   * wrong caption because both were tagged the same generation.
   * Called once per genuinely NEW turn (both call sites below), so
   * every real "final" gets its own fresh generation — a turn is now
   * "superseded" the instant a newer one starts, not only when an
   * explicit interruption says so. Optional and a no-op by default so
   * every existing call site (own or a test's) that doesn't pass this
   * keeps behaving exactly as before. */
  bumpGeneration?: () => void,
): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.type === "UtteranceEnd") {
    // A second, independent "the user is truly done" signal Deepgram sends
    // after utterance_end_ms of silence — a safety net for the rare case a
    // Results message never carries speech_final:true, so a turn can't get
    // permanently stuck with real transcript sitting in the buffer forever.
    if (turnState.buffer) {
      bumpGeneration?.();
      await finalizeTurn(turnState, client, deps, getContext, speakStreamed, history, getGeneration, waitForToolResult, recordMemoryTurn, getScopeId);
    }
    return;
  }

  if (msg.type !== "Results") return;
  const transcript: string | undefined = msg.channel?.alternatives?.[0]?.transcript;
  if (!transcript) return;

  if (!msg.is_final) {
    safeSend(client, { type: "interim", text: turnState.buffer ? `${turnState.buffer} ${transcript}` : transcript });
    return;
  }

  // is_final means this chunk of transcript is stable and won't be
  // revised — it does NOT mean the user is done talking. Deepgram can (and
  // routinely does) finalize several chunks of one continuous utterance in
  // a row with no real pause between them. Only speech_final (endpointing
  // actually detected a pause) means the turn is genuinely over. Found
  // live, not theoretical: treating every is_final as a separate finished
  // question fired two independent LLM+TTS turns for one utterance — the
  // literal cause of both the duplicated transcript entries ("hello" /
  // "hello" with no reply in between) and the agent audibly speaking
  // twice, overlapping.
  turnState.buffer = turnState.buffer ? `${turnState.buffer} ${transcript}` : transcript;
  if (!msg.speech_final) {
    safeSend(client, { type: "interim", text: turnState.buffer });
    return;
  }

  bumpGeneration?.();
  await finalizeTurn(turnState, client, deps, getContext, speakStreamed, history, getGeneration, waitForToolResult, recordMemoryTurn, getScopeId);
}

/**
 * Everything from here on (the LLM call, TTS streaming) can fail in ways
 * that have nothing to do with a malformed message — a flaky provider
 * call, a rate limit, a dropped upstream connection. handleDeepgramMessage
 * is invoked fire-and-forget (`void handleDeepgramMessage(...)`), so an
 * uncaught throw here previously vanished into an unhandled rejection: the
 * client had already been told "final" (entering its "thinking" state) and
 * then simply never heard from the server again for this turn — stuck
 * indefinitely with the mic never resuming. Every path out of the try
 * block now sends the client something that ends the turn.
 *
 * myGeneration is captured before the (potentially slow) LLM call and
 * re-checked before the verb/speech actually goes out — a barge-in that
 * happens while this turn is still "thinking" bumps the generation, and
 * without this check the now-stale response would still land on the
 * client after the user had already moved on to a new question.
 *
 * A continuing verb (click/fill/read/call_tool — TERMINAL_VERBS says which
 * ones aren't) doesn't end the turn here: the server can't execute a DOM
 * action itself, so it sends the step to the client, awaits its real
 * result over waitForToolResult(), folds that into a *local* working copy
 * of history, and calls resolveVerb again — repeat up to the iteration cap
 * (driveAgentLoop's default of 6, in agent-loop.ts — the shared skeleton
 * this function and the HTTP path's runTypedAgentLoop (index.tsx) both
 * drive). The connection's real `history` only gets the user's real
 * question plus the turn's final answer, committed once at the end here —
 * a turn that hits the cap mid-loop doesn't leave partial tool noise in
 * the conversation's real memory.
 */
async function finalizeTurn(
  turnState: { buffer: string },
  client: WebSocket,
  deps: ConnectionDeps,
  getContext: () => { route: string; visible: string[]; liveElements: LiveElement[]; webMcpTools: WebMcpTool[] },
  speakStreamed: (text: string) => Promise<void>,
  history: HistoryTurn[],
  getGeneration: () => number,
  waitForToolResult: () => Promise<string>,
  recordMemoryTurn?: (role: "user" | "assistant", text: string) => void,
  /** Phase 5 step 2 — this connection's real scopeId, if it has one yet
   * (see the "context" message handler). A getter, same pattern as
   * getContext/getGeneration, since it can be set AFTER this turn
   * already started (a scopeId only ever arrives via a "context"
   * message, and a turn can begin before one has). Optional; absent or
   * returning null both mean "no memory-backed tools offered." */
  getScopeId?: () => string | null,
): Promise<void> {
  const transcript = turnState.buffer;
  turnState.buffer = "";
  const myGeneration = getGeneration();
  safeSend(client, { type: "final", text: transcript, generation: myGeneration });

  // The Talker: set once, the first time a turn turns out to need more
  // than one step (see onStep below) — a real, in-flight speakStreamed()
  // call, never awaited until we're actually ready to speak the real
  // answer. Deliberately not re-triggered per step: the Speak connection
  // (speakStreamed) only ever handles one utterance at a time, so a second
  // ack mid-loop would race the first one's own audio_chunk/Flushed
  // handling instead of queuing cleanly.
  let ackPromise: Promise<void> | null = null;

  // Phase 3 step 5 — the Talker's real event stream ("Revisable by
  // Design"'s pattern): a pure, fire-and-forget consumer, never awaited
  // by driveAgentLoop, never able to affect its control flow. This
  // realtime transport's own Talker projection is intentionally small —
  // the only event type it currently DOES anything with is "inj" (the
  // ack phrase), which it turns into the same real speakStreamed() call
  // as before, just reached through a real event instead of an inline
  // side effect inside onStep. "act"/"obs"/"thk" events flow through the
  // same stream (driveAgentLoop already emits act/obs on its own; the
  // Critic below emits a real "thk" with its own reasoning) but aren't
  // consumed for anything yet — logged, not narrated, a real seam for a
  // future richer Talker to attach to without touching the loop again.
  function emitEvent(event: AgentEvent): void {
    switch (event.type) {
      case "inj":
        // Phase 2 step 3 — the ack phrase's audio was already the only
        // thing the user hears; this text-bearing sibling message makes
        // WHAT was said visible in the wire protocol too — today the
        // only way to know (packages/evals' voiceFrames capture full
        // frames, but an "inj" event never otherwise reaches the client
        // as readable text, only as synthesized audio). Purely
        // informational — a client that ignores unknown message types
        // loses nothing.
        safeSend(client, { type: "ack", text: event.text });
        ackPromise = speakStreamed(event.text);
        return;
      case "act":
        console.log("[cairn talker] act:", summarizeVerbForHistory(event.verb));
        return;
      case "obs":
        console.log("[cairn talker] obs:", event.observation);
        return;
      case "thk":
        console.log("[cairn talker] thk:", event.text);
        return;
    }
  }

  // Architecture Pillar 4 — real Plan/Progress state the Critic (below)
  // actually acts on, not just observability. Started EAGERLY, before the
  // first real step even runs, when looksMultiStep(transcript) already
  // flags this as a probable compound goal — replacing the old lazy gate
  // (kicked off only once a turn had already revealed a non-terminal
  // first step, one full model round trip later than it needed to be).
  // A false-negative heuristic miss still falls back to that same lazy
  // path below (`if (planLLM && !planPromise)`), so nothing regresses —
  // this only ever makes planning START EARLIER, never skips it. Only
  // the realtime transport had this Plan/Progress wiring until now — see
  // index.tsx's runTypedAgentLoop for the typed/HTTP transport's own
  // version, added in the same pass.
  let planPromise: Promise<Plan> | null = null;
  let plan: Plan | null = null;
  let progress: ProgressLedger | null = null;
  const STALL_THRESHOLD = 3; // Magentic-One-sized bounded budget before the harness itself escalates to give_up, rather than trusting the Critic alone to notice it's stalling

  try {
    const planLLM = deps.planLLM;
    const criticLLM = deps.criticLLM;

    if (planLLM && looksMultiStep(transcript)) {
      planPromise = resolvePlan(planLLM, transcript, 1, deps.manifest, renderRegisteredActions(deps.registeredActions, deps.actionDescriptions));
    }

    const result = await driveAgentLoop(history, {
      async getNextStep(loopHistory) {
        const { route, visible, liveElements, webMcpTools } = getContext();
        // Phase 5 step 2 — offered only when there's somewhere real to
        // write it (memory configured AND this connection has a real
        // scopeId) — never a tool the model can call into a void.
        const availableTools = deps.memory && getScopeId?.() ? [...webMcpTools, REMEMBER_FACT_TOOL] : webMcpTools;
        return resolveVerb(deps.llm, deps.systemPrompt, deps.manifest, deps.registeredActions, deps.capability, {
          route,
          question: transcript,
          visible,
          liveElements,
          webMcpTools: availableTools,
          history: loopHistory,
        });
      },
      onStep({ verb, iteration, terminal }) {
        if (myGeneration !== getGeneration()) return true; // superseded by a barge-in while this turn was resolving

        // Phase 5 step 2 — a remember_fact call is handled entirely
        // server-side (see executeStep below) and must NEVER be sent to
        // the client: the client would try to look it up in its own
        // real WebMCP tool registry, fail to find it (it's synthetic,
        // server-only), and report an error tool_result back — landing
        // on whatever's THEN occupying the single-slot
        // pendingToolResultResolve, which by then could easily belong
        // to a genuinely later, unrelated step. Suppressing this send
        // is not an optimization, it's what keeps that real race from
        // ever being possible.
        const isRememberFactCall = verb.verb === "call_tool" && verb.name === REMEMBER_FACT_TOOL_NAME;
        if (!isRememberFactCall) {
          // Sent immediately — before speech synthesis even starts — so
          // highlight/navigate/do execute in the browser right away instead
          // of waiting on audio. The agent visibly acts while it's still
          // about to speak, not after.
          safeSend(client, { type: "verb", verb, generation: myGeneration });
        }

        if (!terminal && iteration === 0) {
          // This turn just revealed it needs more than one step — speak a
          // quick, cheap acknowledgment *now*, in parallel with the rest
          // of the loop's own real work below (not awaited here), so the
          // user hears something within about a second instead of dead
          // air for however long the real multi-step answer takes.
          // Single-step turns (the common case) never reach this branch
          // at all, so they keep today's latency exactly as it is.
          // Emitted as a real "inj" event now (step 5), consumed by
          // emitEvent above — same real speakStreamed() call, reached
          // through the event stream instead of an inline side effect.
          emitEvent({ type: "inj", text: ACK_PHRASES[Math.floor(Math.random() * ACK_PHRASES.length)], at: Date.now() });
          // The lazy fallback — only fires when looksMultiStep missed
          // (planPromise is still null): a real Plan is still guaranteed
          // before the Critic needs one, just one round trip later than
          // the eager path above.
          if (planLLM && !planPromise) planPromise = resolvePlan(planLLM, transcript, 1, deps.manifest, renderRegisteredActions(deps.registeredActions, deps.actionDescriptions));
        }
        return false;
      },
      // A continuing step itself stays silent (keeps the loop fast; the
      // client still shows it visually) — wait for its real result and go
      // around again instead of ending the turn.
      executeStep: (verb) => {
        // Phase 5 step 2 — resolved entirely in-process, never routed
        // through the client's real tool-execution round trip (see
        // onStep's own doc comment for why the client is never even
        // told this step happened).
        const currentScopeId = getScopeId?.() ?? null;
        if (verb.verb === "call_tool" && verb.name === REMEMBER_FACT_TOOL_NAME && deps.memory && currentScopeId) {
          return handleRememberFactTool(deps.memory, currentScopeId, verb.args);
        }
        return waitForToolResult();
      },
      onStepResult: () => myGeneration !== getGeneration(),
      onEvent: emitEvent,
      runCritic:
        planLLM && criticLLM
          ? async ({ verb, observation }) => {
              // Real state, not the Executor's self-report — see
              // resolveCritic's own doc comment for why this is a
              // genuinely separate pass, mirroring judge.ts's own
              // precedent. Awaited here (not just logged) on its FIRST
              // use — by now at least one real tool round trip has
              // already happened, so the Planner call kicked off above
              // has likely already resolved in parallel; this is not a
              // NEW blocking wait so much as picking up work already in
              // flight.
              if (!plan) {
                plan = planPromise ? await planPromise : fallbackPlan(transcript, 1);
                progress = { planVersion: plan.version, currentTaskIndex: 0, stallCount: 0 };
              }
              const currentProgress = progress!;
              const currentTask = plan.tasks[currentProgress.currentTaskIndex];
              const verdict = await resolveCritic(criticLLM, currentTask, transcript, verb, observation);
              // A real "thk" event — the Critic's own reasoning, narrated
              // onto the same event stream the ack/act/obs events already
              // flow through (not spoken today, just carried — see
              // emitEvent's own doc comment on why that's a deliberate,
              // small v1 scope).
              emitEvent({ type: "thk", text: verdict.reasoning, at: Date.now() });

              if (verdict.verdict === "task_complete") {
                currentTask.status = "done";
                if (currentProgress.currentTaskIndex < plan.tasks.length - 1) {
                  // More tasks remain — advance and keep looping instead
                  // of ending the turn here.
                  currentProgress.currentTaskIndex++;
                  plan.tasks[currentProgress.currentTaskIndex].status = "in_progress";
                  currentProgress.stallCount = 0;
                  return { ...verdict, verdict: "continue" };
                }
                // The real bug fix: the LAST task is genuinely done —
                // end the loop right here instead of asking the model
                // again and hoping it notices its own success.
                return verdict;
              }

              if (verdict.verdict === "replan") {
                // A fresh Planner call, a real new version — never a
                // silent patch to the existing plan.
                plan = await resolvePlan(planLLM, transcript, plan.version + 1, deps.manifest, renderRegisteredActions(deps.registeredActions, deps.actionDescriptions));
                progress = { planVersion: plan.version, currentTaskIndex: 0, stallCount: 0 };
                return { ...verdict, verdict: "continue" };
              }

              if (verdict.verdict === "give_up") return verdict;

              // "continue" — a harness-enforced fail-safe on top of the
              // Critic's own judgment: crossing a bounded stall budget
              // escalates to give_up itself, rather than trusting the
              // Critic alone to eventually notice it's stuck (Magentic-One's
              // own two-tier tolerance pattern).
              currentProgress.stallCount++;
              if (currentProgress.stallCount >= STALL_THRESHOLD) {
                return {
                  verdict: "give_up",
                  reasoning: `Stuck after ${currentProgress.stallCount} steps with no confirmed progress on "${currentTask.description}" — ${verdict.reasoning}`,
                };
              }
              return verdict;
            }
          : undefined,
    });

    if (result.outcome === "aborted") return;

    if (result.outcome === "terminal" || result.outcome === "unparseable" || result.outcome === "critic-complete") {
      const verb: VerbResponse =
        result.outcome === "terminal"
          ? result.finalVerb
          : result.outcome === "critic-complete"
            ? { verb: "explain", text: result.verdict.reasoning }
            : { verb: "explain", text: "I'm not sure how to help with that." };
      history.push({ role: "user", text: transcript }, { role: "assistant", text: summarizeVerbForHistory(verb) });
      history.splice(0, Math.max(0, history.length - MAX_HISTORY_TURNS));
      recordMemoryTurn?.("user", transcript);
      recordMemoryTurn?.("assistant", summarizeVerbForHistory(verb));

      if (ackPromise) {
        // Never start a second speakStreamed call before the first (the
        // ack) has actually finished — same single Speak connection, one
        // utterance at a time. In the common multi-step case the real
        // work below already took about as long as the ack itself did, so
        // this rarely adds a real wait.
        await ackPromise;
        ackPromise = null;
        if (myGeneration !== getGeneration()) return; // a barge-in could have landed during the ack itself
      }

      // A verb with no spoken text (highlight/navigate/do often have none)
      // still needs to unstick the client's "thinking" state and let the mic
      // resume — turn_complete covers that with no audio path involved.
      const textToSpeak = "text" in verb ? (verb.text ?? undefined) : undefined;

      if (textToSpeak) {
        await speakStreamed(textToSpeak);
      } else {
        safeSend(client, { type: "turn_complete", generation: myGeneration });
      }
      return;
    }

    // Iteration cap hit with no terminal verb, OR the Critic/stall
    // fail-safe gave up — degrade honestly instead of leaving the client
    // waiting forever. A real Critic give-up carries its own specific
    // reasoning, which is a genuinely better message than the generic
    // fallback below — use it when there is one.
    const giveUpText =
      result.outcome === "critic-give-up" ? result.verdict.reasoning : "I wasn't able to finish that — try asking again or breaking it into smaller steps.";
    const gaveUpSummary = result.outcome === "critic-give-up" ? giveUpText : "(gave up after too many steps)";
    history.push({ role: "user", text: transcript }, { role: "assistant", text: gaveUpSummary });
    history.splice(0, Math.max(0, history.length - MAX_HISTORY_TURNS));
    recordMemoryTurn?.("user", transcript);
    recordMemoryTurn?.("assistant", gaveUpSummary);
    safeSend(client, { type: "verb", verb: { verb: "explain", text: giveUpText }, generation: myGeneration });
    if (ackPromise) {
      await ackPromise;
      if (myGeneration !== getGeneration()) return;
    }
    await speakStreamed(giveUpText);
  } catch (err) {
    console.error("[cairn realtime] failed to resolve/speak this turn:", err);
    if (myGeneration === getGeneration()) {
      safeSend(client, { type: "error", message: "Something went wrong answering that — try again." });
      safeSend(client, { type: "turn_complete", generation: myGeneration });
    }
  }
}

function safeSend(client: WebSocket, message: ServerMessage): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify(message));
}

/** Defensive parse for the client's self-reported live DOM scan — same
 * untrusted-input treatment `visible` already gets on this control-message
 * path (no CopilotRequestSchema here, unlike the HTTP handler), just
 * shaped-checked so a malformed entry can't reach the LLM prompt oddly. */
function parseLiveElements(raw: unknown): LiveElement[] {
  if (!Array.isArray(raw)) return [];
  const elements: LiveElement[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof (entry as any).id === "string" &&
      typeof (entry as any).role === "string" &&
      typeof (entry as any).label === "string"
    ) {
      elements.push({ id: (entry as any).id, role: (entry as any).role, label: (entry as any).label });
    }
    if (elements.length >= 60) break;
  }
  return elements;
}

/** Same defensive shape-check as parseLiveElements, for the client's
 * self-reported WebMCP tool list. */
function parseWebMcpTools(raw: unknown): WebMcpTool[] {
  if (!Array.isArray(raw)) return [];
  const tools: WebMcpTool[] = [];
  for (const entry of raw) {
    if (entry && typeof entry === "object" && typeof (entry as any).name === "string" && typeof (entry as any).description === "string") {
      tools.push({ name: (entry as any).name, description: (entry as any).description, inputSchema: (entry as any).inputSchema });
    }
    if (tools.length >= 30) break;
  }
  return tools;
}


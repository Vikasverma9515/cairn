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
import { driveAgentLoop, MAX_HISTORY_TURNS, summarizeVerbForHistory } from "./agent-loop";
import {
  buildSystemPrompt,
  createCriticLLM,
  createPlanLLM,
  createVerbLLM,
  renderRegisteredActions,
  resolveCritic,
  resolvePlan,
  resolveVerb,
  type CapabilityTier,
  type CreateCopilotHandlerOptions,
} from "./server";
import { DeepgramSpeakStream } from "./tts-stream";

const DEEPGRAM_LIVE_URL = "wss://api.deepgram.com/v1/listen";
const DEFAULT_STT_MODEL = "nova-2";
const DEFAULT_TTS_VOICE = "aura-2-thalia-en";
// The Talker half of a Talker/Reasoner split (see finalizeTurn): spoken the
// instant a turn turns out to need more than one step, so the user hears
// something within about a second instead of dead air while the real
// multi-step work runs. A short rotating set, not one fixed line, so it
// doesn't read as a canned bot phrase on every multi-step question.
const ACK_PHRASES = ["Let me check that for you.", "One moment, let me look into that.", "Give me a second to check.", "Let me take a look."];
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

  wss.on("connection", (client) => {
    handleConnection(client, { deepgramApiKey, sttModel, ttsVoice, llm, planLLM, criticLLM, systemPrompt, manifest: options.manifest, registeredActions, actionDescriptions, capability }).catch(
      (err) => {
        console.error("[cairn realtime] connection error:", err);
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
  // Resolves the agent loop's in-flight waitForToolResult() call once the
  // client reports back what a click/fill/read/call_tool step actually
  // did — same "a mutable pending-callback slot, resolved when the right
  // message arrives" pattern onCurrentTurnFlushed already uses below.
  let pendingToolResultResolve: ((observation: string) => void) | null = null;

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

  // Discards whatever the current turn is still synthesizing/sending, and
  // unsticks a pending speakStreamed() call if one is in flight — Deepgram's
  // "Clear" isn't guaranteed to itself trigger a "Flushed" confirmation, so
  // without this the interrupted call's promise would hang forever.
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
      safeSend(client, { type: "audio_chunk", audio: chunk.toString("base64"), sampleRate: TTS_SAMPLE_RATE });
    });

    await ready;
    if (!speakStream || myGeneration !== generation) {
      // Reconnect failed, or barge-in happened before the stream connected —
      // either way, only degrade to turn_complete if this is still current.
      if (myGeneration === generation) safeSend(client, { type: "turn_complete" });
      return;
    }

    await new Promise<void>((resolve) => {
      onCurrentTurnFlushed = () => {
        onCurrentTurnFlushed = null;
        if (myGeneration === generation) safeSend(client, { type: "speaking_end" });
        resolve();
      };
      safeSend(client, { type: "speaking_start" });
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

  // Accumulates Deepgram "Results" transcript segments across one utterance
  // — see handleDeepgramMessage for why this can't just react to every
  // is_final.
  const turnState = { buffer: "" };

  dg.on("message", (data) => {
    void handleDeepgramMessage(data.toString(), client, deps, () => context, speakStreamed, history, turnState, () => generation, waitForToolResult);
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
        context = {
          route: String(msg.route ?? "/"),
          visible: Array.isArray(msg.visible) ? msg.visible : [],
          liveElements: parseLiveElements(msg.liveElements),
          webMcpTools: parseWebMcpTools(msg.webMcpTools),
        };
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
    if (turnState.buffer) await finalizeTurn(turnState, client, deps, getContext, speakStreamed, history, getGeneration, waitForToolResult);
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

  await finalizeTurn(turnState, client, deps, getContext, speakStreamed, history, getGeneration, waitForToolResult);
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
): Promise<void> {
  const transcript = turnState.buffer;
  turnState.buffer = "";
  const myGeneration = getGeneration();
  safeSend(client, { type: "final", text: transcript });

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

  // Phase 3 steps 2-3 — kicked off on the SAME lazy gate as the ack
  // above (only once a turn has already revealed it needs more than one
  // step); real Plan/Progress state the Critic (below) actually acts on,
  // not just observability. Only the realtime transport is wired this
  // way — the typed/HTTP path would need the `{verb, plan?, progress?}`
  // wire-contract change the plan file's own risk section already
  // flagged, deferred until it's genuinely needed there too.
  let planPromise: Promise<Plan> | null = null;
  let plan: Plan | null = null;
  let progress: ProgressLedger | null = null;
  const STALL_THRESHOLD = 3; // Magentic-One-sized bounded budget before the harness itself escalates to give_up, rather than trusting the Critic alone to notice it's stalling

  try {
    const planLLM = deps.planLLM;
    const criticLLM = deps.criticLLM;

    const result = await driveAgentLoop(history, {
      async getNextStep(loopHistory) {
        const { route, visible, liveElements, webMcpTools } = getContext();
        return resolveVerb(deps.llm, deps.systemPrompt, deps.manifest, deps.registeredActions, deps.capability, {
          route,
          question: transcript,
          visible,
          liveElements,
          webMcpTools,
          history: loopHistory,
        });
      },
      onStep({ verb, iteration, terminal }) {
        if (myGeneration !== getGeneration()) return true; // superseded by a barge-in while this turn was resolving

        // Sent immediately — before speech synthesis even starts — so
        // highlight/navigate/do execute in the browser right away instead
        // of waiting on audio. The agent visibly acts while it's still
        // about to speak, not after.
        safeSend(client, { type: "verb", verb });

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
          if (planLLM) planPromise = resolvePlan(planLLM, transcript, 1, deps.manifest, renderRegisteredActions(deps.registeredActions, deps.actionDescriptions));
        }
        return false;
      },
      // A continuing step itself stays silent (keeps the loop fast; the
      // client still shows it visually) — wait for its real result and go
      // around again instead of ending the turn.
      executeStep: () => waitForToolResult(),
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
                plan = planPromise ? await planPromise : { version: 1, goal: transcript, facts: [], tasks: [{ id: "t1", description: transcript, doneContract: "The stated goal has been achieved.", status: "in_progress" }] };
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
      if ("text" in verb && verb.text) {
        await speakStreamed(verb.text);
      } else {
        safeSend(client, { type: "turn_complete" });
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
    history.push({ role: "user", text: transcript }, { role: "assistant", text: result.outcome === "critic-give-up" ? giveUpText : "(gave up after too many steps)" });
    history.splice(0, Math.max(0, history.length - MAX_HISTORY_TURNS));
    safeSend(client, { type: "verb", verb: { verb: "explain", text: giveUpText } });
    if (ackPromise) {
      await ackPromise;
      if (myGeneration !== getGeneration()) return;
    }
    await speakStreamed(giveUpText);
  } catch (err) {
    console.error("[cairn realtime] failed to resolve/speak this turn:", err);
    if (myGeneration === getGeneration()) {
      safeSend(client, { type: "error", message: "Something went wrong answering that — try again." });
      safeSend(client, { type: "turn_complete" });
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


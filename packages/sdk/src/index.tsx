"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Square,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { classifyUiPattern, deriveStructureSignals, isTerminalVerb, safeParseVerbResponse, type CriticVerdict, type HistoryTurn as HistoryEntry, type Plan, type ProgressLedger, type Task, type TourStep, type VerbResponse } from "@cairnvibe/core";
import { driveAgentLoop, looksMultiStep } from "./agent-loop";
import { collectVisible } from "./context-collector";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";
import { createLiveElementRegistry } from "./runtime-scan";
import { discoverWebMcpTools } from "./webmcp-client";
import { executeToolStep, executeVerbResponse } from "./verb-executor";
import { createBargeInGate, createVadDetector } from "./vad";

export interface CopilotProps {
  /** Reserved for a future client-side manifest fetch. Not required — the server handler owns the manifest. */
  manifest?: string;
  /** Where the widget posts questions. Defaults to "/api/copilot". */
  endpoint?: string;
  /** Action ids this deployment actually wired up for the "do" verb. */
  registeredActions?: string[];
  /** Called when the model returns a valid "do" verb for a registered action. */
  onDo?: (action: string, target?: string) => void;
  /** If set, a lookup miss is also POSTed here so failures can be aggregated server-side. */
  reportMissesEndpoint?: string;
  /**
   * If set, shows a mic button that records audio and POSTs it here for
   * transcription — re-sent every ~2s while recording so the field fills in
   * progressively. Hidden automatically if the browser has no mic access.
   */
  transcribeEndpoint?: string;
  /** If set, the widget speaks each explain/highlight answer aloud (Deepgram TTS via `@cairnvibe/sdk/speak-server`). */
  speakEndpoint?: string;
  /**
   * Phase 5 step 4 — whatever opaque id the CUSTOMER's own app already
   * has for this end user (their own login id, or any other stable
   * string they choose) — this SDK invents no identity of its own, same
   * discipline as the realtime relay's own "context" message scopeId.
   * Sent on every typed-transport request when set; the server only ever
   * seeds/records real cross-session memory when BOTH this and a
   * `memory` store are configured (`createCopilotHandler`'s own
   * `memory` option) — omitting this keeps every request exactly as
   * memory-less as before this existed, regardless of server config.
   */
  scopeId?: string;
  /**
   * Architecture Pillar 4 — if set (alongside `criticEndpoint`), the typed/
   * HTTP loop gets the same real Planner the realtime relay already has:
   * a task breakdown for a compound goal, and a genuinely separate Critic
   * pass over each continuing step's real result (packages/sdk/src/
   * server.ts's `createPlanHandler`/`createCriticHandler`). Omitting
   * either endpoint keeps the typed loop exactly as it was — click/fill/
   * read/call_tool executed and folded into history, ended by a terminal
   * verb or the iteration cap — with zero Planner/Critic overhead, same
   * opt-in discipline as speakEndpoint/transcribeEndpoint.
   */
  planEndpoint?: string;
  /** See `planEndpoint` — both must be set for the typed loop's Planner/Critic wiring to activate. */
  criticEndpoint?: string;
  /**
   * Architecture Pillar 3 (Skill half) — if set (alongside `planEndpoint`/
   * `criticEndpoint`), the typed loop saves whatever real, Critic-
   * verified facts a turn collects (`packages/sdk/src/server.ts`'s
   * `createSkillSaveHandler`) once the turn concludes — the same
   * Formulator mechanism the realtime relay already has. Retrieval (a
   * matching Skill's full instructions surfacing to the Planner) needs no
   * separate client wiring — it's already part of what `planEndpoint`'s
   * own server-side handler does once a `SkillStore` is configured there.
   * Omitting this keeps the typed loop exactly as it was — no Skills are
   * ever saved, zero overhead.
   */
  skillsSaveEndpoint?: string;
  /**
   * If set, shows a "start conversation" control that opens a live
   * WebSocket to a `@cairnvibe/sdk/realtime-server` relay (run via
   * `cairn-realtime`) for a real-time voice conversation: streaming
   * transcription, verbs executed as soon as they're resolved, and the
   * answer spoken back — all without you touching the keyboard.
   */
  realtimeUrl?: string;
  /** Display name for the agent, shown in the widget's header and button labels. Defaults to "Cairn". */
  persona?: string;
}

type Status = "idle" | "asking" | "recording" | "rt-connecting" | "rt-listening" | "rt-thinking" | "rt-speaking";

export function Copilot({
  endpoint = "/api/copilot",
  registeredActions = [],
  onDo,
  reportMissesEndpoint,
  transcribeEndpoint,
  speakEndpoint,
  scopeId,
  planEndpoint,
  criticEndpoint,
  skillsSaveEndpoint,
  realtimeUrl,
  persona = "Cairn",
}: CopilotProps) {
  const pathname = usePathname() ?? "/";
  // Mirrors `pathname` for use inside long-lived closures (a realtime
  // session's handlers are all created once, when the connection opens —
  // same staleness reason runTour tracks its own `currentRoute` locally
  // rather than trusting its closure's `pathname` after a mid-tour
  // navigation).
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
    void sendFreshContext(); // no-op if no realtime session is open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Collapsed by default so the panel only ever shows the current exchange
  // — the full archived transcript (built up over a long conversation)
  // stays out of the way behind an explicit toggle instead of always being
  // visible inline, which made the panel grow uncomfortably tall.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  // Real, live-reported gap this closes: once a continuing agent-loop step
  // (click/fill/read/call_tool/batch) sets `answer` to its own progress
  // text ("Typing earbuds into the search box"), that text just sat there
  // unchanged for however long the NEXT resolveVerb call took — several
  // real seconds, more under rate-limit retries — with nothing on screen
  // telling the user the agent was still actually doing something. `answer`
  // itself can't double as that signal (a terminal turn's own real,
  // finished answer looks identical to unfinished progress text). This is
  // a separate, explicit flag: true from the moment a continuing step's
  // progress text is shown until the turn actually ends (a terminal verb,
  // an error, or a give-up) — see its own setters below for exactly where.
  const [loopWorking, setLoopWorking] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [caption, setCaption] = useState("");
  // The user's own last question, shown as its own floating caption bubble
  // alongside the agent's — set once per ask() call, not cleared on
  // completion, so the exchange stays paired on screen the way a caption
  // track shows the current line, not a scrolling transcript.
  const [lastQuestion, setLastQuestion] = useState<string | null>(null);
  // Persistent scroll-back log: previous exchanges get archived here (see
  // archiveCurrentExchange below) the instant a new one starts, so they
  // stay visible — scrolled up, not gone — instead of the old behavior of
  // silently overwriting `answer`/`caption` with nothing left to look back
  // at once the next question began.
  const [transcript, setTranscript] = useState<{ id: number; role: "user" | "agent"; text: string }[]>([]);
  const transcriptIdRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Mirror the values archiveCurrentExchange needs to read from inside
  // stale closures (the realtime WebSocket's onmessage handler is created
  // once per call and doesn't see later renders' state directly — same
  // reason the rest of the realtime path already uses refs like
  // rtStateRef instead of reading state).
  const userCaptionRef = useRef<string>("");
  const answerRef = useRef<string | null>(null);
  const [rtMicMuted, setRtMicMuted] = useState(false);
  const [rtSpeakerMuted, setRtSpeakerMuted] = useState(false);
  // Set while a "tour" verb's steps are being narrated/highlighted one at a
  // time — drives the step-progress caption and blocks the *typed* input so
  // a typed question can't collide with the walkthrough (a voice
  // interruption is handled separately — see touringRef/triggerBargeIn).
  const [tourStep, setTourStep] = useState<{ index: number; total: number } | null>(null);
  const tourGenerationRef = useRef(0); // bumped to cancel an in-progress tour (e.g. widget closed, or a voice barge-in) without extra flags
  // Mirrors whether a tour is running, for use inside the mic's
  // onaudioprocess callback (a stale closure over React state there would
  // miss a tour that started after the callback was created) — a tour
  // reuses "rt-speaking" to hold the mic off between steps, but IS
  // barge-in-able like a real conversational reply (see the RMS check
  // below): interrupting mid-tour cancels the rest of the walkthrough,
  // the way a real person giving a tour stops when you have a question
  // instead of talking over you.
  const touringRef = useRef(false);
  // Resolver for "this tour step's audio has fully finished playing" when
  // narrating over an already-open realtime session (see maybeResumeListening
  // and speakOverRealtime) — set right before sending a step's text, cleared
  // once it resolves.
  const rtTourAudioDoneRef = useRef<(() => void) | null>(null);
  // Conversation memory for the typed/mic path. Not React state — nothing
  // about it should trigger a re-render, it just needs to persist across
  // ask() calls and be resent each time (see ask() below; the realtime path
  // keeps its own history server-side instead, since that connection is
  // already stateful).
  const historyRef = useRef<HistoryEntry[]>([]);

  // A background scanner that keeps a live inventory of what's actually
  // clickable on screen right now (runtime-scan.ts) — running continuously
  // via a MutationObserver so there's never a pause to "go look at the
  // page" right when a verb needs to click something. `liveMapRef` freezes
  // one snapshot of it per turn (set alongside every context/question send,
  // below) so a background rescan landing mid-flight can't shift what an id
  // resolves to between when a request went out and its response came back.
  const liveRegistryRef = useRef(createLiveElementRegistry());
  const liveMapRef = useRef<Map<string, HTMLElement>>(new Map());
  useEffect(() => {
    liveRegistryRef.current.start();
    return () => liveRegistryRef.current.stop();
  }, []);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const transcribeInFlightRef = useRef(false);
  const rtSocketRef = useRef<WebSocket | null>(null);
  const rtCleanupRef = useRef<(() => void) | null>(null);
  const rtStateRef = useRef<Status>("idle"); // mirrors `status` for use inside audio callbacks (avoids stale closures)
  const rtMicMutedRef = useRef(false);
  const rtSpeakerMutedRef = useRef(false);
  const rtStartingRef = useRef(false); // closes the click-to-first-state-update gap so a rapid double-click can't open two sessions
  // The generation of the most recent "final" this client has processed —
  // see ServerMessage's own doc comment in realtime-server.ts for the full
  // real, live-found bug this closes: the client's own local barge-in can
  // start a NEW turn (a new "final") before an EARLIER turn's own verb/
  // audio, already in flight on the wire when the server processed that
  // barge-in, actually arrives. WebSocket delivers messages in order, but
  // "in order" isn't "still current" — every verb/speaking_start/
  // audio_chunk/speaking_end/turn_complete message carries the generation
  // it was produced under, and the handler drops it outright if it's
  // older than this ref's value instead of applying it to whatever
  // caption happens to be showing now.
  const rtLastFinalGenerationRef = useRef(0);
  // Progressive PCM playback for the buffered (non-realtime) speak endpoint
  // — the same gapless AudioBufferSourceNode scheduling the realtime path
  // uses for its audio_chunk messages (see rtPlaybackCtxRef below), just fed
  // by a fetch() ReadableStream instead of WebSocket messages. This exists
  // because res.blob()/res.arrayBuffer() always wait for the whole response
  // body in every browser no matter how the server sent it — streaming the
  // wire alone (speak-server.ts) doesn't help unless playback also starts
  // before the full reply has arrived.
  const typedPlaybackCtxRef = useRef<AudioContext | null>(null);
  const typedPlaybackGainRef = useRef<GainNode | null>(null);
  const typedNextPlayTimeRef = useRef(0);
  const typedScheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // Bumped by stopTypedPlayback() every time it runs — playPcmStream's own
  // async reader loop checks this before scheduling each chunk, so a
  // superseded call (two speak()/ask() replies resolving close together)
  // actually STOPS reading and scheduling more audio once a newer call has
  // taken over, instead of continuing to push nodes into the shared
  // playback graph behind the newer call's back. stopTypedPlayback() on
  // its own only ever stopped nodes that already existed at the moment it
  // ran — it never told an in-flight stream reader to stop producing MORE
  // of them, which is exactly what let two replies' audio genuinely
  // overlap (one starting, then a second call's audio starting on top of
  // it moments later) — a real, live-found race, not a guess.
  const typedPlaybackGenerationRef = useRef(0);
  // A DIFFERENT real gap the generation counter above doesn't close: it
  // only protects one typed reply's audio against ANOTHER typed reply's
  // audio. A typed ask()/speak() call already in flight — its /api/
  // copilot/speak fetch genuinely takes several seconds under real
  // conditions (rate-limit retries make this worse, not better) — has no
  // way to know a realtime call started WHILE it was still waiting. Its
  // response arrives, and normally-innocent code plays it, seconds after
  // startRealtime() already ran — genuinely overlapping with the live
  // call's own audio, since nothing about the realtime session's own
  // start/mute/barge-in controls have any way to reach a typed reply
  // that hadn't even been scheduled yet when they ran. Found live: two
  // full agent answers, sourced entirely from separate /api/copilot/
  // speak calls, audibly overlapping about a second apart, while a
  // realtime call was the only thing visibly active in the UI the whole
  // time. startRealtime() sets this; endRealtime() clears it; speak()/
  // speakAndWait() check it AFTER their fetch resolves and drop the
  // reply's audio entirely (never call playPcmStream at all) if a
  // realtime call has taken over since the request was made.
  const typedPlaybackSuspendedRef = useRef(false);
  // Watchdog for the "rt-thinking" state: started on every "final" transcript,
  // cleared the moment the server responds with anything for that turn
  // (verb/speaking_start/speaking_end/turn_complete/error). If it ever
  // fires, the server went silent for this turn — force the mic back to
  // listening instead of leaving the session stuck showing "Thinking…"
  // forever with no way to speak again short of ending the call.
  const rtThinkingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Streamed TTS playback: each server audio_chunk is raw PCM16, scheduled
  // as its own AudioBufferSourceNode straight into this graph, gapless,
  // instead of buffering a whole clip into one <audio> element first — that
  // buffering was the "agent takes 5-10s to speak" bug (nothing plays until
  // Deepgram AND the network finish delivering the entire reply).
  const rtPlaybackCtxRef = useRef<AudioContext | null>(null);
  const rtPlaybackGainRef = useRef<GainNode | null>(null);
  const rtNextPlayTimeRef = useRef(0);
  const rtScheduledSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // True once the server says no more audio_chunks are coming for the
  // current turn (speaking_end/turn_complete) — listening only resumes once
  // this AND every scheduled chunk has actually finished playing, not just
  // finished arriving, so the mic can't start sending while the agent is
  // still audibly speaking.
  const rtAudioDoneArrivingRef = useRef(true);
  // Diagnostic only, not a functional guard — flips to true the first time
  // a real mic packet is actually sent after transitioning to
  // "rt-listening", logged once (not per-packet, which would flood the
  // console). Added specifically so a "status says Listening… but nothing
  // I say gets picked up" report can be told apart, from the log alone,
  // between "the send gate never opened" (this never logs) and "the gate
  // opened and sent real audio, so the problem is somewhere else entirely
  // — Deepgram's own STT, or a real hardware/OS mic issue this app can't
  // see or fix" (this logs once, then goes quiet as expected).
  const micAudioSentSinceListeningRef = useRef(false);

  // Safety net for a live realtime call outliving this component instance:
  // without this, unmounting (a parent removing the widget, a route change
  // that remounts it, or — the real, live-hit case — Next.js Fast Refresh
  // remounting the component on every dev-mode source edit while a call is
  // open) left the WebSocket, the open getUserMedia mic stream, and both
  // AudioContexts running completely orphaned: nothing ever called
  // rtSocketRef.current?.close() or stopped the mic tracks. The old,
  // zombie connection then kept transcribing and replying in parallel with
  // whatever the newly-mounted instance does next — the literal
  // "two things running in parallel, the agent answering twice" bug found
  // live. endRealtime() is safe to call from an unmount cleanup even
  // though it also calls React state setters: it only reads stable refs
  // (never a stale closure over props/state), and React 18 silently no-ops
  // a setState call on an already-unmounted component.
  useEffect(() => {
    return () => {
      if (rtSocketRef.current || rtCleanupRef.current) endRealtime();
    };
  }, []);

  // Starts false on both server and client's first render (avoids a
  // hydration mismatch — `navigator` doesn't exist during SSR), then
  // updated after mount, once we're only ever running in the browser.
  const [micSupported, setMicSupported] = useState(false);
  useEffect(() => {
    setMicSupported(!!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
  }, []);

  const asking = status === "asking";
  const recording = status === "recording";
  const realtimeActive = status.startsWith("rt-");
  const touring = tourStep !== null;
  const busy = asking || status === "rt-thinking" || touring;

  // `caption` is overloaded by design (see its setters above): during a
  // tour it's a step-progress label ("Step 1 of 2"), not user speech, so it
  // reads as a small chip over the agent's bubble instead. While actively
  // recording or on a live realtime call it's the user's own live/last
  // transcript, so it reads as the user's floating bubble; otherwise that
  // slot falls back to the last typed question.
  const tourChip = touring ? caption : "";
  const userCaption = !touring && (recording || realtimeActive) ? caption : lastQuestion ?? "";

  useEffect(() => {
    userCaptionRef.current = userCaption;
  }, [userCaption]);
  useEffect(() => {
    answerRef.current = answer;
  }, [answer]);

  // Auto-scroll to the newest content whenever the transcript grows or the
  // live (not-yet-archived) bubble's text changes.
  useEffect(() => {
    const el = panelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, answer, userCaption, busy]);

  /**
   * Moves whatever's currently showing as the "live" exchange into the
   * permanent transcript log, right before it's about to be overwritten by
   * a new turn — called at the start of ask(), at the start of each
   * realtime "final" transcript, and at the start of a tour/tour step. Its
   * effect is exactly "previous goes up, recent shows": the outgoing
   * text becomes a fixed history entry the instant the incoming one starts
   * replacing it, instead of just vanishing.
   */
  function archiveText(role: "user" | "agent", text: string) {
    if (!text) return;
    setTranscript((prev) => [...prev, { id: transcriptIdRef.current++, role, text }]);
  }

  function archiveCurrentExchange() {
    archiveText("user", userCaptionRef.current);
    archiveText("agent", answerRef.current ?? "");
  }

  function setRtStatus(next: Status) {
    rtStateRef.current = next;
    setStatus(next);
  }

  /**
   * Refreshes the server's picture of route/visible/liveElements over an
   * already-open realtime connection. Beyond the initial connect, called
   * on every route change and whenever the mic is about to start listening
   * again — a real, pre-existing gap this closes as a side effect: the
   * server's context previously updated only once, at connection open, so
   * navigating mid-call (via a "navigate" verb, or the user clicking
   * around) left the server answering every later turn as if the user were
   * still on the original page. Reads pathnameRef, not the closure's
   * `pathname`, so it's correct even called from a handler created once at
   * connection-open time.
   */
  async function sendFreshContext() {
    const ws = rtSocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const liveScan = liveRegistryRef.current.getSnapshot();
    liveMapRef.current = liveScan.byId;
    const webMcpTools = await discoverWebMcpTools();
    if (ws.readyState !== WebSocket.OPEN) return; // may have closed while awaiting discovery
    ws.send(
      JSON.stringify({
        type: "context",
        route: pathnameRef.current,
        visible: collectVisible(),
        liveElements: liveScan.elements,
        webMcpTools,
      }),
    );
  }

  function reportMiss(context: MissContext) {
    logMiss(context);
    if (reportMissesEndpoint) {
      fetch(reportMissesEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      }).catch(() => {});
    }
  }

  function handleVerb(raw: unknown) {
    setLoopWorking(false); // only ever called for a genuinely terminal verb — the turn is over
    executeVerbResponse(raw, pathname, {
      onExplain: (text) => {
        setAnswer(text);
        // A REAL, deep, long-standing bug found live — not introduced by
        // today's other fixes, just newly diagnosed: this function is a
        // plain closure defined fresh every render, but when a "verb" WS
        // message arrives it's invoked through ws.onmessage — a callback
        // assigned ONCE, inside startRealtime(), and never reassigned for
        // the rest of that connection's life. `realtimeActive` there is
        // therefore frozen at whatever it was AT THE MOMENT startRealtime()
        // was called — which is BEFORE the click handler's own state
        // updates land, so it reads `false` for literally the entire
        // lifetime of every realtime call. `!realtimeActive` was therefore
        // ALWAYS true here, on every single realtime turn — this ran
        // speak() (the typed HTTP path) in addition to the correct
        // realtime audio_chunk playback, every time. This is the actual,
        // original root cause of "two speakers" — the earlier
        // typedPlaybackSuspendedRef fix only ever suppressed the resulting
        // AUDIO once this was already firing, it never stopped the
        // firing itself (or the wasted LLM/TTS call and quota burn
        // underneath it). rtStateRef mirrors status specifically to avoid
        // this class of bug in a callback like this one (see its own doc
        // comment) — using it here instead of the stale const is the
        // actual fix.
        if (rtStateRef.current.startsWith("rt-")) {
          rtLog("explain: realtime call active, letting the socket's own audio_chunk stream speak this");
        } else {
          rtLog("explain: no realtime call active, using the typed speak() HTTP path");
          void speak(text);
        }
      },
      onNavigate: (route) => router.push(route),
      onMiss: reportMiss,
      onDo,
      onTour: (steps) => void runTour(steps),
      registeredActions,
      liveElements: liveMapRef.current,
    });
  }

  /**
   * Walks a "tour" verb's steps one at a time: highlight this step's
   * target (if any), speak/show its text, wait for that to finish, then
   * move on — this is what makes a multi-part answer feel like someone
   * actually showing you around instead of one paragraph naming several
   * buttons at once with nothing highlighted.
   *
   * During a live realtime session, narration reuses the same streaming
   * Speak connection a normal conversational reply uses (see
   * speakOverRealtime below) instead of a separate buffered REST call —
   * otherwise falls back to speakEndpoint. Either way, the mic is held off
   * between steps (mirrors "rt-speaking") so it doesn't pick up the tour's
   * own narration — but it's still listening for a real interruption:
   * talking during a step cancels the rest of the tour via triggerBargeIn,
   * the same as interrupting a normal spoken reply.
   */
  async function runTour(steps: TourStep[]) {
    const myGeneration = ++tourGenerationRef.current;
    // Same real stale-closure bug as onExplain's own fix above, and the
    // reason a realtime-triggered tour spoke through the wrong pipeline
    // (or, after that fix suppressed the wrong pipeline's audio, spoke
    // through nothing at all — "tour did not speak anything") and could
    // leave the mic never properly told to resume listening afterward
    // (see the `setRtStatus("rt-listening")` call at the end of this
    // function, fixed the same way). rtStateRef.current is always
    // current, regardless of which render's closure this particular
    // invocation runs inside.
    const wasRealtimeListening = rtStateRef.current.startsWith("rt-");
    touringRef.current = true;
    if (wasRealtimeListening) setRtStatus("rt-speaking");
    // No archiveCurrentExchange() here: whatever triggered this tour (a typed
    // ask() or a realtime "final") already archived the exchange *before*
    // this one — by the time a tour's "verb" message arrives, the triggering
    // question is the CURRENT turn, still live in userCaption for the whole
    // tour. Archiving it again here would just duplicate it (verified live —
    // this used to show the triggering question twice).
    setAnswer(null);
    // Tracked locally rather than reading the component's `pathname` —
    // that's only current as of this render, and a step below can navigate
    // mid-tour (router.push doesn't update it synchronously, and this
    // async function's closure over the render-time value would otherwise
    // go stale for every step after the first navigation).
    let currentRoute = pathname;

    try {
      for (let i = 0; i < steps.length; i++) {
        if (tourGenerationRef.current !== myGeneration) return; // superseded — e.g. widget closed or a new question came in
        const step = steps[i];
        // Move the previous step's narration into history before this one replaces it —
        // agent-only, since the tour's triggering question was already archived once, above.
        if (i > 0) archiveText("agent", answerRef.current ?? "");
        setTourStep({ index: i, total: steps.length });
        setCaption(`Step ${i + 1} of ${steps.length}`);
        setAnswer(step.text);

        if (step.route && step.route !== currentRoute) {
          router.push(step.route);
          currentRoute = step.route;
          // router.push() in the App Router doesn't return a promise to
          // await — a short fixed pause is the pragmatic way to give the
          // new route's DOM a moment to mount before the target lookup
          // below runs against it. Steps already pace at 1-3s+ for
          // narration, so this doesn't read as a hang.
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (tourGenerationRef.current !== myGeneration) return;
        }

        if (step.target) {
          // A fresh scan, not the tour's starting liveMapRef snapshot — a
          // step after a mid-tour navigation targets elements on a page
          // that didn't exist when the tour began.
          const liveScan = liveRegistryRef.current.getSnapshot();
          const el = findElement(step.target, liveScan.byId);
          if (el) {
            highlightElement(el);
            if (step.click) {
              el.click();
              // Give whatever the click reveals (a detail view, an expanded
              // row) a moment to actually render before narrating it.
              await new Promise((resolve) => setTimeout(resolve, 400));
              if (tourGenerationRef.current !== myGeneration) return;
            }
          } else {
            reportMiss({ attempted: step.target, route: currentRoute });
          }
        }

        if (wasRealtimeListening && rtSocketRef.current?.readyState === WebSocket.OPEN) {
          // Already have a live streaming connection open — reuse it
          // (same Speak WS, same gapless PCM scheduling a normal reply
          // uses) instead of falling back to a separate buffered REST call.
          await speakOverRealtime(step.text);
        } else if (speakEndpoint) {
          await speakAndWait(step.text);
        } else {
          // No TTS configured — pace by an estimate of reading time instead
          // of racing through every step instantly.
          await new Promise((resolve) => setTimeout(resolve, Math.max(1200, step.text.length * 45)));
        }
        if (tourGenerationRef.current !== myGeneration) return;
      }

      if (tourGenerationRef.current !== myGeneration) return;
      setTourStep(null);
      setCaption("");
      // The most damaging half of this stale-closure bug: this used to
      // read the stale `realtimeActive` const, which meant this call was
      // ALWAYS skipped for a tour reached via realtime — the mic was
      // never explicitly told to resume listening once the tour ended.
      // rtStateRef.current.startsWith("rt-") is what actually reflects
      // whether the connection is still live right now.
      if (wasRealtimeListening && rtStateRef.current.startsWith("rt-")) setRtStatus("rt-listening");
    } catch (err) {
      // Real, live-found gap: this function had NO catch at all — only
      // try/finally. Any error thrown anywhere in the loop above (a
      // rejected speakOverRealtime/speakAndWait call, a DOM exception
      // from el.click(), a network failure) skipped the resume-listening
      // line above ENTIRELY, leaving the mic stuck exactly where the
      // tour left off — matching "after this it's not listening"
      // reported live. Every other place in this file that can fail
      // mid-turn (ask(), handleDeepgramMessage's own server-side
      // equivalent) already guarantees SOME recovery path; this one
      // didn't have one at all.
      console.error("[cairn] tour failed partway through:", err);
      rtLog("tour failed — forcing the mic back to listening instead of leaving it stuck", { error: String(err) });
      setTourStep(null);
      setCaption("");
      if (wasRealtimeListening && rtStateRef.current.startsWith("rt-")) setRtStatus("rt-listening");
    } finally {
      if (tourGenerationRef.current === myGeneration) touringRef.current = false;
    }
  }

  // ---------------------------------------------------------------------
  // Typed / push-to-talk question flow
  // ---------------------------------------------------------------------

  async function ask(q: string) {
    archiveCurrentExchange();
    setStatus("asking");
    setAnswer(null);
    setLastQuestion(q);
    setQuestion("");
    try {
      await runTypedAgentLoop(q);
    } catch {
      // See typedPlaybackSuspendedRef's own doc comment — this whole
      // fetch can still be in flight when a realtime call starts.
      if (!typedPlaybackSuspendedRef.current) setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      // The most damaging form of the same race: unconditionally forcing
      // status back to "idle" here, after a realtime call has ALREADY
      // taken over (status is some "rt-*" value), would silently kick the
      // UI out of the live call — hiding its mic/speaker/hangup controls
      // and showing the "start call" screen instead — while the actual
      // WebSocket connection underneath is still fully alive and still
      // talking, now with no visible way to manage it at all. Skipping
      // this reset when suspended is what stops a slow, stale typed
      // request from ever being able to do that.
      if (!typedPlaybackSuspendedRef.current) setStatus("idle");
    }
  }

  /**
   * Architecture Pillar 6 (the safety layer) — the real, working default
   * confirmation UI: a native browser confirm dialog, naming the tool's
   * OWN real name/description (never inventing wording), for a WebMCP
   * tool whose registration declared `riskTier: "confirm"` (a payment, a
   * delete, anything hard to undo). `window.confirm` blocks the calling
   * microtask until the user actually answers — exactly the real,
   * synchronous "get a genuine yes before this runs" behavior needed
   * here, and simple enough to need no new UI component for this to be a
   * real, functioning default rather than just plumbing with nothing on
   * the other end. A host app wanting a nicer in-widget modal can still
   * build one — this function is the only thing that would need
   * replacing to do that.
   */
  function confirmToolCall(tool: { name: string; description: string }): Promise<boolean> {
    if (typeof window === "undefined" || typeof window.confirm !== "function") return Promise.resolve(false);
    const message = tool.description ? `${tool.name}: ${tool.description}\n\nAllow this action?` : `Allow "${tool.name}"?`;
    return Promise.resolve(window.confirm(message));
  }

  /**
   * Architecture Pillar 4 — the typed transport's own Planner call,
   * mirroring resolvePlan's real network shape but reached over HTTP
   * (planEndpoint's server-side handler — createPlanHandler in server.ts
   * — is the only place that can hold the real LLM API key). Never
   * throws: any network/parse failure degrades to the exact same single-
   * task fallback plan resolvePlan itself falls back to on an LLM error,
   * so a Planner hiccup never blocks the turn.
   */
  async function fetchPlan(goal: string, version = 1): Promise<Plan> {
    try {
      const res = await fetch(planEndpoint!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal, version }),
      });
      const data = await res.json();
      if (data && typeof data === "object" && Array.isArray((data as Plan).tasks) && (data as Plan).tasks.length > 0) return data as Plan;
    } catch {
      // Falls through to the same fallback plan shape below.
    }
    return { version, goal, facts: [], tasks: [{ id: "t1", description: goal, doneContract: "The stated goal has been achieved.", status: "in_progress" }] };
  }

  /** Same real-network shape as fetchPlan, for criticEndpoint's
   * createCriticHandler — degrades to a safe "continue" verdict on any
   * failure, same resilience discipline as resolveCritic itself. */
  async function fetchCriticVerdict(task: Task, goal: string, verb: VerbResponse, observation: string | null | undefined): Promise<CriticVerdict> {
    try {
      const res = await fetch(criticEndpoint!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task, goal, verb, observation: observation ?? null }),
      });
      const data = await res.json();
      if (data && typeof (data as CriticVerdict).verdict === "string") return data as CriticVerdict;
    } catch {
      // Falls through to the safe default below.
    }
    return { verdict: "continue", reasoning: "Critic call failed — defaulting to continue rather than blocking the turn." };
  }

  /**
   * Architecture Pillar 3 (Skill half) — the typed transport's own
   * Formulator save, mirroring realtime-server.ts's own post-turn
   * `compileSkill`+`saveSkill` call. Fire-and-forget (never awaited by
   * the caller, never allowed to affect what the user sees) since saving
   * a Skill is bookkeeping for a FUTURE turn, not part of answering this
   * one — matches the Formulator's own "cheap, runs once per turn, never
   * blocks anything" framing. Classifies the current live page for a
   * best-effort pattern tag the same way resolveVerb's own per-request
   * classification does server-side.
   */
  function saveSkillIfLearned(goal: string, learnedFacts: string[]): void {
    if (!skillsSaveEndpoint || learnedFacts.length === 0) return;
    const matches = classifyUiPattern(deriveStructureSignals(liveRegistryRef.current.getSnapshot().elements));
    void fetch(skillsSaveEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal, learnedFacts, pattern: matches[0]?.pattern }),
    }).catch(() => {
      // A Skill that fails to save just means the next similar goal
      // starts from scratch again, same as if nothing had been learned
      // this turn — never worth surfacing as a user-visible error.
    });
  }

  /**
   * Drives the agent loop over the stateless HTTP path: ask the server,
   * and if it comes back with a continuing step (click/fill/read/
   * call_tool — TERMINAL_VERBS in @cairnvibe/core says which verbs end a
   * turn), execute that step for real, fold the real result into this
   * turn's own working history, and ask again — repeat until a terminal
   * verb or the iteration cap, instead of the old one-call-one-answer
   * shape. `question` stays the original ask on every call; only
   * `history` grows with each step's real trace, so the model always
   * still knows what it was actually asked. `historyRef` (the
   * conversation's real memory) is only ever committed once, at the end —
   * a turn that hits the cap mid-loop doesn't leave partial noise in it.
   * The loop itself (the `for`/TERMINAL_VERBS/iteration-cap shape) lives
   * in agent-loop.ts, shared with the realtime relay's own finalizeTurn —
   * this function owns everything transport-specific: the actual fetch,
   * the raw/untyped response handling a stateless HTTP call needs (unlike
   * realtime's always-valid in-process resolveVerb call), and the real
   * historyRef commit.
   */
  async function runTypedAgentLoop(q: string): Promise<void> {
    const webMcpTools = await discoverWebMcpTools();
    let lastRawResponse: unknown = null;

    // Architecture Pillar 4 — real Planner/Critic wiring for the typed
    // transport, opt-in via planEndpoint/criticEndpoint (see their own
    // doc comments on CopilotProps) — closes the gap the plan file names
    // directly ("the typed/HTTP path has zero Planner/Critic wiring at
    // all... today explicitly realtime-only by deferral, not by
    // decision"). Mirrors realtime-server.ts's finalizeTurn: an eager
    // Planner kickoff when looksMultiStep(q) already flags a probable
    // compound goal, a lazy fallback kickoff on the first continuing step
    // otherwise, and a genuinely separate Critic pass over each
    // continuing step's real result. Neither endpoint set (the default)
    // means plannerEnabled is false and this whole block is a no-op —
    // the typed loop behaves exactly as it always has.
    let planPromise: Promise<Plan> | null = null;
    let plan: Plan | null = null;
    let progress: ProgressLedger | null = null;
    const STALL_THRESHOLD = 3; // same bounded budget realtime's own Critic wiring uses
    const plannerEnabled = Boolean(planEndpoint && criticEndpoint);
    if (plannerEnabled && looksMultiStep(q)) planPromise = fetchPlan(q);
    // Architecture Pillar 3 (Skill half) — every real, Critic-verified
    // learnedFact from this turn's steps; saved once the turn concludes,
    // below (saveSkillIfLearned). Empty is the common case, not a gap.
    const learnedFacts: string[] = [];

    const result = await driveAgentLoop(historyRef.current, {
      async getNextStep(loopHistory) {
        const liveScan = liveRegistryRef.current.getSnapshot();
        liveMapRef.current = liveScan.byId;
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            // pathnameRef, not the closed-over `pathname` — a navigate
            // step (now possibly continuing, see isTerminalVerb) can
            // change the real route mid-loop; this whole async function's
            // own `pathname` closure was captured once, at the render
            // that started this turn, and never updates again on its own.
            route: pathnameRef.current,
            question: q,
            visible: collectVisible(),
            history: loopHistory,
            liveElements: liveScan.elements,
            webMcpTools,
            scopeId,
          }),
        });
        const data = await res.json().catch(() => null);
        lastRawResponse = data;
        return safeParseVerbResponse(data);
      },
      onStep({ verb, terminal }) {
        // A continuing step — show it happening (execution itself
        // happens in executeStep below). Terminal steps are handled once
        // driveAgentLoop returns, via handleVerb — unchanged from before.
        // Same stale-typed-reply guard as the terminal case below — a
        // multi-step typed loop can still be mid-flight when a realtime
        // call starts.
        if (!terminal && !typedPlaybackSuspendedRef.current) {
          setAnswer(summarizeVerbForHistory(verb));
          setLoopWorking(true);
        }
        // The lazy fallback — only fires when looksMultiStep missed
        // (planPromise is still null): a real Plan is still guaranteed
        // before the Critic needs one, just one round trip later.
        if (!terminal && plannerEnabled && !planPromise) planPromise = fetchPlan(q);
        return false;
      },
      // Same real, live-found fix as the realtime WS "verb" handler's own
      // executeToolStep call — a fresh scan per step, not the turn's
      // frozen liveMapRef, so a step that reveals new DOM (a click that
      // opens a modal) doesn't leave the NEXT step unable to find
      // anything in it.
      executeStep: (verb) => executeToolStep(verb, pathnameRef.current, liveRegistryRef.current.getSnapshot().byId, (route) => router.push(route), confirmToolCall).then((r) => r?.observation),
      runCritic: plannerEnabled
        ? async ({ verb, observation }) => {
            // Real state, not the Executor's self-report — see
            // resolveCritic's own doc comment (server.ts) for why this is
            // a genuinely separate pass, same precedent realtime already
            // established.
            if (!plan) {
              plan = planPromise ? await planPromise : await fetchPlan(q);
              progress = { planVersion: plan.version, currentTaskIndex: 0, stallCount: 0 };
            }
            const currentProgress = progress!;
            const currentTask = plan.tasks[currentProgress.currentTaskIndex];
            const verdict = await fetchCriticVerdict(currentTask, q, verb, observation);
            if (verdict.learnedFact) learnedFacts.push(verdict.learnedFact);

            if (verdict.verdict === "task_complete") {
              currentTask.status = "done";
              if (currentProgress.currentTaskIndex < plan.tasks.length - 1) {
                // More tasks remain — advance and keep looping instead of
                // ending the turn here.
                currentProgress.currentTaskIndex++;
                plan.tasks[currentProgress.currentTaskIndex].status = "in_progress";
                currentProgress.stallCount = 0;
                return { ...verdict, verdict: "continue" };
              }
              // The last task is genuinely done — end the loop right here
              // instead of asking the model again and hoping it notices.
              return verdict;
            }

            if (verdict.verdict === "replan") {
              plan = await fetchPlan(q, plan.version + 1);
              progress = { planVersion: plan.version, currentTaskIndex: 0, stallCount: 0 };
              return { ...verdict, verdict: "continue" };
            }

            if (verdict.verdict === "give_up") return verdict;

            // "continue" — a harness-enforced fail-safe on top of the
            // Critic's own judgment, same Magentic-One-shaped two-tier
            // tolerance realtime already uses.
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

    // Architecture Pillar 3 (Skill half) — the Formulator, once per turn.
    saveSkillIfLearned(q, learnedFacts);

    if (result.outcome === "terminal" || result.outcome === "unparseable" || result.outcome === "critic-complete") {
      // A realtime call can start WHILE this whole typed loop (potentially
      // several real fetches deep) was still in flight — applying this
      // reply now would overwrite the live call's own answer with a
      // stale, orphaned bubble that doesn't correspond to anything the
      // realtime conversation actually said. speak()/speakAndWait() guard
      // the AUDIO half of this same real, live-found race (see
      // typedPlaybackSuspendedRef's own doc comment) — this is the
      // matching guard for the TEXT half, which would otherwise still
      // leak through even with the audio silenced.
      // The Critic independently confirmed the last task's doneContract
      // is satisfied even though the model's own verb never got there —
      // real fix for the diagnosed bug (a batch succeeded and the model
      // kept looping instead of recognizing it). No raw server response
      // exists for this synthesized verb (it never came from `endpoint`
      // at all), so it's built directly from the verdict's own reasoning
      // — same shape realtime-server.ts synthesizes for the same outcome.
      const raw: unknown = result.outcome === "critic-complete" ? { verb: "explain", text: result.verdict.reasoning } : lastRawResponse;
      if (typedPlaybackSuspendedRef.current) {
        rtLog("dropping stale typed reply's text — a realtime call started while it was still in flight");
      } else {
        handleVerb(raw);
      }
      // Unlike the realtime relay (one persistent connection, memory
      // lives server-side), each of these POSTs is stateless — the
      // widget itself is what remembers, and resends it above so the
      // model has context for "the first one" / "do that instead" on
      // the next question. Summarized from the RAW response (not
      // driveAgentLoop's typed finalVerb) via this file's own untyped
      // summarizeVerbForHistory — deliberately, since a response that
      // failed schema validation (outcome "unparseable") can still carry
      // real, usable fields (e.g. a stray extra property tripped
      // .strict() while `text` itself was fine) that only the untyped,
      // duck-typed summarizer sees; there is no typed finalVerb at all
      // for that outcome.
      historyRef.current = [
        ...result.workingHistory,
        { role: "user", text: q } satisfies HistoryEntry,
        { role: "assistant", text: summarizeVerbForHistory(raw) } satisfies HistoryEntry,
      ].slice(-MAX_HISTORY_TURNS);
      return;
    }

    // "gave-up" (iteration cap hit with no terminal verb) OR "critic-give-up"
    // (the Critic/stall fail-safe decided continuing wouldn't help — its
    // own reasoning is a genuinely better message than the generic
    // fallback, same as realtime-server.ts's own finalizeTurn).
    const giveUpText =
      result.outcome === "critic-give-up" ? result.verdict.reasoning : "I wasn't able to finish that — try asking again or breaking it into smaller steps.";
    const gaveUpSummary = result.outcome === "critic-give-up" ? giveUpText : "(gave up after too many steps)";
    setLoopWorking(false);
    setAnswer(giveUpText);
    historyRef.current = [
      ...result.workingHistory,
      { role: "user", text: q } satisfies HistoryEntry,
      { role: "assistant", text: gaveUpSummary } satisfies HistoryEntry,
    ].slice(-MAX_HISTORY_TURNS);
  }

  function ensureTypedPlaybackGraph(): { ctx: AudioContext; gain: GainNode } {
    if (!typedPlaybackCtxRef.current) {
      const ctx = new AudioContext();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      typedPlaybackCtxRef.current = ctx;
      typedPlaybackGainRef.current = gain;
    }
    return { ctx: typedPlaybackCtxRef.current, gain: typedPlaybackGainRef.current! };
  }

  /** Stops whatever's currently playing on the typed/mic path's playback
   * graph, so two responses (e.g. a rapid double-click, or two answers
   * resolved close together) can never be heard overlapping. Also bumps
   * typedPlaybackGenerationRef — see its own doc comment for why that's
   * required for this to actually hold when a NEW reply's audio is still
   * arriving as a stream, not just already fully scheduled. */
  function stopTypedPlayback() {
    typedPlaybackGenerationRef.current++;
    for (const source of typedScheduledSourcesRef.current) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // may already have finished naturally
      }
    }
    typedScheduledSourcesRef.current = [];
    typedNextPlayTimeRef.current = typedPlaybackCtxRef.current?.currentTime ?? 0;
  }

  function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  /**
   * Reads a raw linear16 PCM stream (mono, 24kHz — matches speak-server.ts)
   * and schedules it gapless-appended into the Web Audio graph as chunks
   * arrive — the same technique the realtime path uses for its audio_chunk
   * messages, just driven by a fetch() reader instead of WebSocket frames.
   * Resolves once every scheduled chunk has actually finished *playing*,
   * not just finished arriving.
   */
  function playPcmStream(stream: ReadableStream<Uint8Array>): Promise<void> {
    stopTypedPlayback();
    const myGeneration = typedPlaybackGenerationRef.current;
    const { ctx, gain } = ensureTypedPlaybackGraph();
    void ctx.resume().catch(() => {});

    return new Promise((resolve) => {
      let doneArriving = false;
      let leftover: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

      const maybeResolve = () => {
        if (doneArriving && typedScheduledSourcesRef.current.length === 0) resolve();
      };

      const scheduleChunk = (bytes: Uint8Array) => {
        const sampleCount = Math.floor(bytes.length / 2);
        if (sampleCount === 0) return;
        const float32 = new Float32Array(sampleCount);
        const view = new DataView(bytes.buffer, bytes.byteOffset, sampleCount * 2);
        for (let i = 0; i < sampleCount; i++) float32[i] = view.getInt16(i * 2, true) / 32768;

        const buffer = ctx.createBuffer(1, sampleCount, 24000);
        buffer.copyToChannel(float32, 0);

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(gain);

        const startAt = Math.max(ctx.currentTime, typedNextPlayTimeRef.current);
        source.start(startAt);
        typedNextPlayTimeRef.current = startAt + buffer.duration;

        typedScheduledSourcesRef.current.push(source);
        source.onended = () => {
          typedScheduledSourcesRef.current = typedScheduledSourcesRef.current.filter((s) => s !== source);
          maybeResolve();
        };
      };

      (async () => {
        const reader = stream.getReader();
        try {
          for (;;) {
            // A newer call already ran stopTypedPlayback() (bumping the
            // generation) while we were mid-read — stop here instead of
            // scheduling more chunks behind its back. Checked both before
            // AND after the await: a supersede can land at any point while
            // this loop is blocked waiting on the next chunk.
            if (typedPlaybackGenerationRef.current !== myGeneration) break;
            const { done, value } = await reader.read();
            if (typedPlaybackGenerationRef.current !== myGeneration) break;
            if (done) break;
            if (!value || value.length === 0) continue;
            // PCM16 samples are 2 bytes each — a chunk boundary can split a
            // sample in half, so carry any odd trailing byte into the next
            // read instead of corrupting one sample at every chunk seam.
            const combined = concatBytes(leftover, value);
            const usableLen = combined.length - (combined.length % 2);
            scheduleChunk(combined.subarray(0, usableLen));
            leftover = combined.subarray(usableLen);
          }
        } catch {
          // Best-effort — never let a stream read failure hang the caller forever.
        } finally {
          doneArriving = true;
          maybeResolve();
        }
      })();
    });
  }

  async function speak(text: string) {
    if (!speakEndpoint || !text.trim()) return;
    try {
      const res = await fetch(speakEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) return;
      // A realtime call can start WHILE this fetch was in flight — see
      // typedPlaybackSuspendedRef's own doc comment for why that's a real,
      // live-found overlapping-audio case, not a hypothetical one.
      if (typedPlaybackSuspendedRef.current) {
        rtLog("dropping stale typed reply's audio — a realtime call started while it was still being fetched");
        return;
      }
      void playPcmStream(res.body);
    } catch {
      // Best-effort — never let speech playback break the widget.
    }
  }

  /** Like speak(), but resolves once playback actually finishes — used by
   * runTour() so each step's highlight stays up for exactly as long as its
   * narration takes, instead of racing ahead to the next step. */
  async function speakAndWait(text: string): Promise<void> {
    if (!speakEndpoint || !text.trim()) return;
    try {
      const res = await fetch(speakEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok || !res.body) return;
      // See speak()'s own identical check and typedPlaybackSuspendedRef's
      // doc comment — a realtime call can start while this fetch was in
      // flight, same real risk here.
      if (typedPlaybackSuspendedRef.current) {
        rtLog("dropping stale typed reply's audio — a realtime call started while it was still being fetched");
        return;
      }
      await playPcmStream(res.body);
    } catch {
      // Best-effort — never let a synthesis failure hang the tour forever.
    }
  }

  /** Like speakAndWait(), but narrates over an already-open realtime
   * WebSocket instead of a separate REST call — same streaming Speak
   * connection and gapless PCM scheduling a normal conversational reply
   * uses, so a tour that happens mid-call is exactly as fast to start
   * speaking as the conversation itself. Resolved by maybeResumeListening()
   * (defined in startRealtime, where the audio_chunk scheduling lives) once
   * this step's audio has both fully arrived and fully finished playing. */
  function speakOverRealtime(text: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = rtSocketRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      rtAudioDoneArrivingRef.current = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        rtTourAudioDoneRef.current = null;
        resolve();
      };
      rtTourAudioDoneRef.current = finish;
      // Safety net: if the server's "this step's audio is fully done"
      // confirmation is ever dropped (a flaky Deepgram Flushed event, a
      // closed connection mid-turn), don't let the tour hang on this step
      // forever with the mic never resuming — move on instead.
      setTimeout(() => {
        if (!settled) rtLog("tour step audio confirmation timed out after 15s — continuing anyway");
        finish();
      }, 15000);
      ws.send(JSON.stringify({ type: "speak", text }));
    });
  }

  async function startRecording() {
    if (!transcribeEndpoint || !micSupported || realtimeActive) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      setCaption("");
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        audioChunksRef.current.push(e.data);
        void transcribeSoFar(recorder.mimeType || "audio/webm", true);
      };
      recorder.onstop = () => {
        void transcribeSoFar(recorder.mimeType || "audio/webm", false);
      };
      mediaRecorderRef.current = recorder;
      recorder.start(2000);
      setStatus("recording");
    } catch {
      setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
    }
  }

  function stopRecording() {
    const stream = mediaRecorderRef.current?.stream;
    mediaRecorderRef.current?.stop();
    stream?.getTracks().forEach((track) => track.stop());
    setStatus("idle");
  }

  async function transcribeSoFar(mimeType: string, isProgressive: boolean) {
    if (!transcribeEndpoint) return;
    if (isProgressive && transcribeInFlightRef.current) return;
    transcribeInFlightRef.current = true;
    try {
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      const res = await fetch(transcribeEndpoint, { method: "POST", headers: { "content-type": mimeType }, body: blob });
      const data = await res.json().catch(() => null);
      if (data?.text) {
        setQuestion(data.text);
        setCaption(data.text);
      } else if (!isProgressive) {
        setAnswer("Couldn't make that out — try typing instead.");
      }
    } catch {
      if (!isProgressive) setAnswer("Couldn't reach the transcription service.");
    } finally {
      transcribeInFlightRef.current = false;
    }
  }

  // ---------------------------------------------------------------------
  // Real-time voice conversation
  // ---------------------------------------------------------------------

  async function startRealtime() {
    // rtStartingRef closes the gap between click and the first state update
    // landing — without it a rapid double-click (or two-finger tap) could
    // race past the `realtimeActive` check twice and open two sessions,
    // which is exactly what "hearing the agent twice, in parallel" was.
    if (!realtimeUrl || !micSupported || realtimeActive || rtStartingRef.current) return;
    rtLog("starting realtime call", { url: realtimeUrl });
    rtStartingRef.current = true;
    // A typed/mic-recorded reply's audio can still be mid-playback on its
    // own separate graph (typedPlaybackGainRef, only ever touched by
    // stopTypedPlayback/playPcmStream) when the user switches straight into
    // a live call — endRealtime() already stops it on the way OUT of a
    // call, but nothing stopped it on the way IN, so it kept playing
    // completely unaffected by the realtime session's own mute-speaker
    // button (which only ever touches rtPlaybackGainRef) or by barge-in —
    // a real, live-found "two independent speakers" bug: muting or saying
    // "stop" only ever reached the realtime pipeline, while this leftover
    // typed audio played on regardless until it finished on its own.
    stopTypedPlayback();
    // Also blocks any typed reply that's still mid-fetch RIGHT NOW (not
    // yet playing anything, so stopTypedPlayback() above has nothing to
    // stop) from playing its audio once it finally arrives, seconds from
    // now — see typedPlaybackSuspendedRef's own doc comment.
    typedPlaybackSuspendedRef.current = true;
    archiveCurrentExchange(); // preserve whatever typed/mic exchange preceded switching into a live call
    setAnswer(null);
    setCaption("");
    setRtStatus("rt-connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ws = new WebSocket(realtimeUrl);
      ws.binaryType = "arraybuffer";
      rtSocketRef.current = ws;

      // Separate AudioContext from the mic capture graph below — one for
      // capture, one for playback, matching how the two are independently
      // lifecycled (playback keeps scheduling audio after a turn while the
      // mic graph is simultaneously idle, and vice versa).
      const playbackCtx = new AudioContext();
      const playbackGain = playbackCtx.createGain();
      playbackGain.gain.value = rtSpeakerMutedRef.current ? 0 : 1;
      playbackGain.connect(playbackCtx.destination);
      rtPlaybackCtxRef.current = playbackCtx;
      rtPlaybackGainRef.current = playbackGain;
      rtNextPlayTimeRef.current = 0;
      rtScheduledSourcesRef.current = [];
      rtAudioDoneArrivingRef.current = true;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated in favor of AudioWorklet, but needs
      // no separate worklet file to serve — fine for this scope, still
      // supported everywhere. Routed through a silent gain (not straight to
      // destination) so the mic input is never audibly looped back.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const silence = audioCtx.createGain();
      silence.gain.value = 0;
      const bargeInVad = createVadDetector();
      // Real, live-reported bug this closes: firing triggerBargeIn() off a
      // SINGLE ~85-100ms VAD frame meant one cough or door-slam frame that
      // happened to pass the energy+ZCR gate cut the agent off, permanently
      // (no server-side "was this real" recovery exists anymore — see
      // vad.ts's own doc comment for why that was removed instead of kept).
      // Real research into how production voice-agent platforms solve this
      // (Pipecat, LiveKit Agents, Vapi, Deepgram's Voice Agent API — see
      // DEVELOPMENT.md) converges on gating the LOCAL trigger on SUSTAINED
      // speech across a minimum duration instead — Pipecat's own production
      // spec cites 250ms, Vapi's stopSpeakingPlan defaults to 0.2s. This
      // gate does exactly that, entirely client-side (no network round trip
      // or STT-transcript timing involved, so it can't reintroduce the
      // removed server-side race).
      const bargeInGate = createBargeInGate();

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (rtMicMutedRef.current) return;

        // Barge-in: while the agent is speaking a real conversational reply,
        // still thinking about one, OR mid-tour, keep listening to the mic
        // locally even though it isn't being sent yet, and cut the agent
        // off once the user has been sustainedly talking again (bargeInGate,
        // above) instead of making them wait — including during a guided
        // tour, which now cancels the rest of the walkthrough on
        // interruption (see triggerBargeIn) instead of being talked-over-
        // proof by design, the way a real person giving a tour stops when
        // you have a question. The "rt-thinking" half matters just as much
        // as "rt-speaking": an LLM turn can easily take a couple of seconds
        // with nothing playing yet, and without this the mic was completely
        // deaf during that whole window — found live as "not listening
        // while speaking... no interrupting system", not just a missed
        // nice-to-have.
        if (rtStateRef.current === "rt-speaking" || rtStateRef.current === "rt-thinking") {
          const frame = bargeInVad.process(e.inputBuffer.getChannelData(0));
          const frameDurationMs = (e.inputBuffer.length / audioCtx.sampleRate) * 1000;
          if (bargeInGate.update(frame, frameDurationMs)) triggerBargeIn();
          return;
        }
        bargeInGate.reset(); // not currently interruptible — don't let stale progress from a moment ago carry into the next speaking/thinking phase

        if (rtStateRef.current !== "rt-listening") return; // don't send our own mic while the agent is thinking/speaking
        if (!micAudioSentSinceListeningRef.current) {
          micAudioSentSinceListeningRef.current = true;
          rtLog("mic audio actually being sent (send gate is open)");
        }
        const pcm = floatTo16BitPCM(downsampleTo16k(e.inputBuffer.getChannelData(0), audioCtx.sampleRate));
        ws.send(pcm);
      };
      source.connect(processor);
      processor.connect(silence);
      silence.connect(audioCtx.destination);

      // Real, live-reported bug this closes: "status says Listening but
      // nothing gets picked up" — traced to browsers deliberately
      // suspending an AudioContext that has no active OUTPUT (a real,
      // documented power-saving policy, not backgrounded-tab-only). This
      // capture context has no real output at all by design (silence's
      // gain is 0), making it exactly the shape most likely to get
      // silently suspended — and once suspended, onaudioprocess simply
      // stops firing, so nothing inside it can detect or recover from its
      // own silence. A periodic external health check is the only
      // reliable way to catch this: resume the context if the browser
      // suspended it, and — a real, separate failure mode — detect the
      // mic's OWN MediaStreamTrack actually ending or going muted (device
      // unplugged, OS-level permission revoked mid-call, another app
      // taking exclusive access) and surface a real, honest error instead
      // of silently going deaf with the UI still claiming to listen.
      const micHealthCheck = setInterval(() => {
        if (audioCtx.state !== "running") {
          rtLog("capture AudioContext was suspended — resuming", { state: audioCtx.state });
          void audioCtx.resume().catch((err) => rtLog("failed to resume capture AudioContext", { error: String(err) }));
        }
        const track = stream.getAudioTracks()[0];
        if (track && (track.readyState === "ended" || track.muted)) {
          rtLog("mic track is no longer live — ending the call", { readyState: track.readyState, muted: track.muted });
          setAnswer("The microphone connection was lost — try starting the call again.");
          endRealtime();
        }
      }, 2000);

      // The track's own "ended" event is the immediate signal (fires the
      // instant the OS/browser actually kills the track) — the poll above
      // is the safety net for anything that doesn't fire it reliably
      // (muted-without-ended has no dedicated event in the spec).
      const handleMicTrackEnded = () => {
        rtLog("mic track ended unexpectedly — ending the call");
        setAnswer("The microphone connection was lost — try starting the call again.");
        endRealtime();
      };
      stream.getAudioTracks().forEach((t) => t.addEventListener("ended", handleMicTrackEnded));

      rtCleanupRef.current = () => {
        clearInterval(micHealthCheck);
        stream.getAudioTracks().forEach((t) => t.removeEventListener("ended", handleMicTrackEnded));
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void audioCtx.close();
        stopScheduledRtAudio();
        void playbackCtx.close();
        rtPlaybackCtxRef.current = null;
        rtPlaybackGainRef.current = null;
      };

      // Only flips back to "listening" (and lets the mic resume sending —
      // see the listening-only send guard above) once BOTH the server has
      // said no more audio is coming for this turn AND every chunk already
      // scheduled has actually finished playing. Doing this from playback
      // completion rather than from the server's speaking_end alone is what
      // stops the mic picking up the tail end of the agent's own voice.
      //
      // Shared with runTour()'s speakOverRealtime(): while touring, this
      // same "audio fully drained" condition resolves the current step's
      // wait instead of touching rtStatus/caption — a tour owns those for
      // its whole duration, not per step.
      function maybeResumeListening() {
        if (!rtAudioDoneArrivingRef.current) return;
        if (rtScheduledSourcesRef.current.length > 0) return;
        if (touringRef.current) {
          rtTourAudioDoneRef.current?.();
          rtTourAudioDoneRef.current = null;
          return;
        }
        rtLog("resumed listening");
        void audioCtx.resume().catch(() => {}); // don't wait up to 2s for the periodic health check if the browser already suspended capture
        micAudioSentSinceListeningRef.current = false;
        setRtStatus("rt-listening");
        setCaption("");
        void sendFreshContext(); // refresh before the user starts talking again, not after
      }

      function disarmThinkingWatchdog() {
        if (rtThinkingWatchdogRef.current) {
          clearTimeout(rtThinkingWatchdogRef.current);
          rtThinkingWatchdogRef.current = null;
        }
      }

      function armThinkingWatchdog() {
        disarmThinkingWatchdog();
        rtThinkingWatchdogRef.current = setTimeout(() => {
          rtThinkingWatchdogRef.current = null;
          rtLog("thinking watchdog fired — server took over 20s, resuming listening and abandoning that turn");
          // Real, live-found gap: this used to only reset LOCAL state,
          // never telling the server anything — so a turn that was simply
          // SLOW (not actually stuck; e.g. retrying a rate-limited call
          // across every configured key, which can genuinely take longer
          // than this 20s watchdog) kept running server-side, and its
          // reply arrived LATE, after the user had already moved on and
          // started a new turn locally — landing on whatever was now
          // showing instead of being recognized as stale. triggerBargeIn()
          // is exactly the fix: it sends the same real barge_in signal a
          // genuine interruption does, bumping the server's own generation
          // so that late reply — whenever it finally arrives — carries an
          // old generation number and gets correctly dropped by the
          // isStaleRtMessage check above instead of confusingly resuming.
          triggerBargeIn();
          setLoopWorking(false);
          // triggerBargeIn() clears the caption but never touched `answer`
          // — without this, a timed-out turn gave the user literally
          // nothing: no reply, no error, just a silent reset back to
          // "Listening…" that reads as "it heard me and did nothing." A
          // real, live-found gap, not just a console.warn nobody sees.
          setAnswer("That's taking longer than expected — try asking again.");
        }, 20000);
      }

      function stopScheduledRtAudio() {
        for (const node of rtScheduledSourcesRef.current) {
          try {
            node.stop();
          } catch {
            // may have already finished naturally
          }
        }
        rtScheduledSourcesRef.current = [];
        rtNextPlayTimeRef.current = rtPlaybackCtxRef.current?.currentTime ?? 0;
      }

      // Stops the agent immediately (locally) and tells the server to
      // discard whatever it's still synthesizing/sending for this turn —
      // the server tags every turn with a generation number and drops any
      // now-stale audio_chunk/speaking_end that was already in flight, so a
      // few straggling chunks can't sneak back in and resume playback.
      function triggerBargeIn() {
        rtLog("barge-in triggered", { wasTouring: touringRef.current, discardedAudioChunks: rtScheduledSourcesRef.current.length });
        disarmThinkingWatchdog();
        stopScheduledRtAudio();
        rtAudioDoneArrivingRef.current = true;
        if (touringRef.current) {
          // Interrupting mid-guide cancels the whole rest of the tour, not
          // just the current step — the way a real person giving a tour
          // stops and answers your question instead of continuing to talk
          // over you. Without resolving the current step's own pending
          // promise here, runTour only notices the cancellation via its own
          // 15s-per-step fallback timeout instead of right away.
          tourGenerationRef.current++;
          touringRef.current = false;
          setTourStep(null);
          rtTourAudioDoneRef.current?.();
          rtTourAudioDoneRef.current = null;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "barge_in" }));
        setRtStatus("rt-listening");
        // Real, live-found bug this fix removes: this used to also clear
        // the caption here (setCaption("")). That's correct-looking for a
        // REAL, VAD-triggered barge-in (the user's about to say something
        // new) — the very next "final" already does archiveCurrentExchange()
        // then overwrites caption with the new utterance, so clearing it
        // here was always redundant for that path. But this function is
        // ALSO called by the thinking watchdog on a timeout, where there is
        // no new utterance coming — clearing the caption there wiped out
        // the very question that just timed out, an instant before
        // setAnswer(the timeout message) ran, leaving the live pair as
        // {caption: "", answer: "That's taking longer..."} — a reply
        // visibly floating with no question above it, and nothing for
        // archiveCurrentExchange() to pair it with on the next turn either
        // (archiveText skips empty text). Simply never clearing it here is
        // correct for both callers: the barge-in path already gets a fresh
        // caption from the next "final", and the watchdog path now keeps
        // the timed-out question correctly paired with its own answer.
      }

      ws.onopen = () => {
        rtLog("connection open");
        sendFreshContext();
        setRtStatus("rt-listening");
        rtStartingRef.current = false;
      };

      // True for a verb/speaking_start/audio_chunk/speaking_end/
      // turn_complete message that belongs to an EARLIER turn than the
      // most recent "final" this client has seen — see
      // rtLastFinalGenerationRef's own doc comment for the real race this
      // closes. A message with no generation field at all (shouldn't
      // happen against a server running this fix, but a mismatched client/
      // server version pair during a rolling deploy could) is treated as
      // current rather than dropped — additive/backward-compatible, same
      // discipline every other wire-protocol addition in this codebase
      // follows.
      function isStaleRtMessage(msg: { generation?: unknown }): boolean {
        const stale = typeof msg.generation === "number" && msg.generation < rtLastFinalGenerationRef.current;
        if (stale) rtLog("dropped stale message", { type: (msg as { type?: unknown }).type, messageGeneration: msg.generation, currentGeneration: rtLastFinalGenerationRef.current });
        return stale;
      }

      let audioChunkCount = 0;

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return; // audio now arrives as base64 inside audio_chunk, not raw binary frames
        const msg = JSON.parse(event.data);
        if (msg.type === "interim") {
          setCaption(msg.text);
        } else if (msg.type === "final") {
          rtLog("final transcript", { text: msg.text, generation: msg.generation });
          rtLastFinalGenerationRef.current = typeof msg.generation === "number" ? msg.generation : 0;
          archiveCurrentExchange(); // the previous turn's pair is complete — move it into history before this one starts overwriting caption/answer
          setCaption(msg.text);
          // Without this, `answer` still held the PREVIOUS turn's reply
          // text at the moment this new turn's own reply — if it ever
          // arrives — would overwrite it. Usually invisible (the previous
          // reply lands well before the next "final"), but a barge-in can
          // supersede an in-flight turn before its reply ever arrives (see
          // realtime-server.ts's onStep generation check) — with no reply
          // ever coming for THIS caption, the stale previous-turn answer
          // sat there and got archived alongside the wrong question on the
          // NEXT final, showing as a mismatched or duplicated-looking
          // reply. Found live: two turns' worth of the same fallback error
          // text ("Something went wrong on my end") appearing back to back
          // with only one visible question between them. Clearing to null
          // here means an abandoned turn now correctly archives with NO
          // reply bubble (archiveText skips empty text) instead of someone
          // else's.
          setAnswer(null);
          setRtStatus("rt-thinking");
          armThinkingWatchdog();
        } else if (msg.type === "verb") {
          if (isStaleRtMessage(msg)) return; // belongs to a turn a later "final" already superseded
          rtLog("verb received", { verb: msg.verb?.verb, generation: msg.generation });
          const parsedStep = safeParseVerbResponse(msg.verb);
          if (parsedStep && !isTerminalVerb(parsedStep)) {
            // A continuing agent-loop step (click/fill/read/call_tool) —
            // the turn isn't over: execute it for real and report the
            // result back so the server can decide the next step, instead
            // of treating this like a normal answer (no
            // disarmThinkingWatchdog/handleVerb — those are for when a
            // turn actually ends). Shown visually so a multi-step turn
            // reads as visible progress, not a silent pause; never spoken
            // — the server's loop stays quiet between steps on purpose,
            // to keep it fast.
            setAnswer(summarizeVerbForHistory(msg.verb));
            setLoopWorking(true);
            // A FRESH scan, not the turn's starting liveMapRef snapshot —
            // real, live-found bug: a step in THIS SAME multi-step turn
            // (a "click New Agent" that opens a modal) can reveal DOM a
            // later step (a "fill" targeting the modal's own input) needs
            // to find, and liveMapRef is deliberately frozen once per
            // turn (see its own doc comment — that freeze exists to stop
            // a background rescan from shifting an id mid-flight during
            // ONE step's own round trip, not to survive across several
            // sequential steps that genuinely changed the page).
            // runTour() already does exactly this for its own steps, for
            // the identical reason. Without it, "click New Agent, then
            // type the name" reliably failed every time with "Could not
            // find that element on the page" — confirmed live, repeated
            // 5+ times in a row without ever recovering.
            const freshLiveMap = liveRegistryRef.current.getSnapshot().byId;
            void executeToolStep(msg.verb, pathnameRef.current, freshLiveMap, (route) => router.push(route), confirmToolCall).then((result) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "tool_result", observation: result?.observation ?? "no result" }));
              }
            });
            return;
          }
          disarmThinkingWatchdog();
          handleVerb(msg.verb);
        } else if (msg.type === "speaking_start") {
          if (isStaleRtMessage(msg)) return;
          rtLog("speaking start", { generation: msg.generation });
          audioChunkCount = 0;
          disarmThinkingWatchdog();
          rtAudioDoneArrivingRef.current = false;
          setRtStatus("rt-speaking");
        } else if (msg.type === "audio_chunk") {
          if (isStaleRtMessage(msg)) return; // the literal "two speakers" case — a chunk from an abandoned turn, already in flight when the barge-in landed
          audioChunkCount++;
          const ctx = rtPlaybackCtxRef.current;
          const gain = rtPlaybackGainRef.current;
          if (!ctx || !gain) return;
          void ctx.resume().catch(() => {});

          // Decode base64 linear16 PCM -> Float32 samples in [-1, 1], then
          // schedule gapless-appended after whatever's already queued
          // (rtNextPlayTimeRef) — this is what lets playback start on the
          // first chunk instead of waiting for the whole reply.
          const bytes = Uint8Array.from(atob(msg.audio), (c) => c.charCodeAt(0));
          const sampleCount = bytes.length / 2;
          const float32 = new Float32Array(sampleCount);
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < sampleCount; i++) {
            float32[i] = view.getInt16(i * 2, true) / 32768;
          }
          const sampleRate = typeof msg.sampleRate === "number" ? msg.sampleRate : 24000;
          const buffer = ctx.createBuffer(1, sampleCount, sampleRate);
          buffer.copyToChannel(float32, 0);

          const bufferSource = ctx.createBufferSource();
          bufferSource.buffer = buffer;
          bufferSource.connect(gain);

          const startAt = Math.max(ctx.currentTime, rtNextPlayTimeRef.current);
          bufferSource.start(startAt);
          rtNextPlayTimeRef.current = startAt + buffer.duration;

          rtScheduledSourcesRef.current.push(bufferSource);
          bufferSource.onended = () => {
            rtScheduledSourcesRef.current = rtScheduledSourcesRef.current.filter((n) => n !== bufferSource);
            maybeResumeListening();
          };
        } else if (msg.type === "speaking_end" || msg.type === "turn_complete") {
          if (isStaleRtMessage(msg)) return; // a newer turn's own speaking_end/turn_complete will arrive and resume listening correctly on its own
          rtLog(msg.type, { audioChunks: audioChunkCount, generation: msg.generation });
          // turn_complete covers a verb with nothing spoken (a plain
          // highlight/navigate/do often has no text) — no audio_chunk ever
          // arrives for it, so rtScheduledSourcesRef is already empty and
          // maybeResumeListening() resumes immediately below.
          disarmThinkingWatchdog();
          rtAudioDoneArrivingRef.current = true;
          maybeResumeListening();
        } else if (msg.type === "error") {
          rtLog("server error", { message: msg.message });
          // Must actually unstick the turn, not just show the message —
          // otherwise the mic never resumes and the session is stuck
          // exactly the way a silently-dropped response used to leave it.
          disarmThinkingWatchdog();
          setLoopWorking(false);
          setAnswer(msg.message ?? "Something went wrong.");
          if (touringRef.current) {
            // A tour step's own speakStreamed() failed server-side (see
            // realtime-server.ts's "speak" handler). Without resolving this
            // step's pending promise here, runTour's `await
            // speakOverRealtime(step.text)` only recovers via its own 15s
            // fallback timeout — found live as a guide that goes badly
            // quiet for long stretches, one step at a time.
            rtAudioDoneArrivingRef.current = true;
            rtTourAudioDoneRef.current?.();
            rtTourAudioDoneRef.current = null;
          } else {
            setRtStatus("rt-listening");
            setCaption("");
          }
        }
      };

      ws.onerror = () => {
        rtLog("connection error");
        setAnswer("Couldn't connect to the realtime voice service.");
        endRealtime();
      };
      ws.onclose = (closeEvent) => {
        rtLog("connection closed", { code: closeEvent.code, reason: closeEvent.reason, wasIdle: rtStateRef.current === "idle" });
        if (rtStateRef.current !== "idle") endRealtime();
      };
    } catch {
      setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
      setRtStatus("idle");
      rtStartingRef.current = false;
      typedPlaybackSuspendedRef.current = false; // the call never actually started — don't leave typed replies permanently silenced
    }
  }

  function endRealtime() {
    rtLog("ending realtime call", { statusAtEnd: rtStateRef.current });
    if (rtThinkingWatchdogRef.current) {
      clearTimeout(rtThinkingWatchdogRef.current);
      rtThinkingWatchdogRef.current = null;
    }
    rtStartingRef.current = false;
    stopTypedPlayback();
    typedPlaybackSuspendedRef.current = false; // typed replies work normally again once no live call can race them
    rtSocketRef.current?.close();
    rtSocketRef.current = null;
    rtCleanupRef.current?.();
    rtCleanupRef.current = null;
    setRtMicMuted(false);
    setRtSpeakerMuted(false);
    setCaption("");
    setRtStatus("idle");
    setLoopWorking(false); // defensive — a connection dropping mid-loop must never leave the "still working" indicator stuck on
    tourGenerationRef.current++; // cancel an in-progress tour rather than leaving it stuck waiting to resume rt-listening
    touringRef.current = false;
    setTourStep(null);
    // Unstick a tour step mid-narration over realtime — the socket above is
    // already closed, so nothing will ever deliver the audio_chunk/speaking_end
    // that would normally resolve this; without forcing it, runTour()'s
    // await would hang forever instead of noticing the generation bump above.
    rtTourAudioDoneRef.current?.();
    rtTourAudioDoneRef.current = null;
  }

  function toggleRtMic() {
    rtMicMutedRef.current = !rtMicMutedRef.current;
    setRtMicMuted(rtMicMutedRef.current);
  }

  function toggleRtSpeaker() {
    rtSpeakerMutedRef.current = !rtSpeakerMutedRef.current;
    setRtSpeakerMuted(rtSpeakerMutedRef.current);
    // Zeroing the shared gain node silences output immediately, including
    // whatever's mid-playback right now, and applies to every future
    // scheduled chunk automatically — no per-chunk check needed.
    if (rtPlaybackGainRef.current) {
      rtPlaybackGainRef.current.gain.value = rtSpeakerMutedRef.current ? 0 : 1;
    }
  }

  const statusLabel: Record<Status, string> = {
    idle: "",
    asking: "Thinking…",
    recording: "Listening — transcribing live…",
    "rt-connecting": "Connecting…",
    "rt-listening": "Listening…",
    "rt-thinking": "Thinking…",
    "rt-speaking": "Speaking…",
  };

  return (
    <>
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: COPILOT_STYLES }} />
      <button
        className={status === "rt-speaking" ? "cairn-fab cairn-fab-speaking" : "cairn-fab"}
        aria-label={open ? `Close ${persona} help` : `Open ${persona} help`}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <X size={22} /> : <CairnMark />}
      </button>
      {open && (
        <div className="cairn-panel" role="dialog" aria-label={`${persona} help panel`} ref={panelRef}>

          {(transcript.length > 0 || userCaption || answer || busy) && (
            <div className="cairn-stack">
              {transcript.length > 0 && (
                <button
                  type="button"
                  className="cairn-history-toggle"
                  onClick={() => setHistoryExpanded((v) => !v)}
                  aria-expanded={historyExpanded}
                >
                  {historyExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  {historyExpanded ? "Hide earlier" : `${transcript.length} earlier`}
                </button>
              )}
              {historyExpanded &&
                transcript.map((entry) => (
                  <div
                    className={entry.role === "user" ? "cairn-bubble cairn-bubble-user cairn-bubble-past" : "cairn-bubble cairn-bubble-agent cairn-bubble-past"}
                    key={entry.id}
                  >
                    {entry.role === "agent" ? <span className="cairn-bubble-text">{entry.text}</span> : entry.text}
                  </div>
                ))}
              {userCaption && (
                <div className="cairn-bubble cairn-bubble-user" key={`u-${userCaption}`}>
                  {userCaption}
                </div>
              )}
              {(answer || busy) && (
                <div className="cairn-bubble cairn-bubble-agent" key={`a-${answer ?? status}`}>
                  {tourChip && <span className="cairn-chip">{tourChip}</span>}
                  {answer ? (
                    <span className="cairn-bubble-text">
                      {renderCaptionWords(answer)}
                      {loopWorking && (
                        // Real, live-reported gap this closes: this bubble
                        // used to go static the instant a continuing step's
                        // own progress text was shown ("Typing earbuds into
                        // the search box"), with nothing telling the user
                        // the agent was still actively working for however
                        // long the next real LLM call took. Appended inline
                        // (not swapped in place of the text, which the
                        // no-answer-yet case below does) so the progress
                        // text stays legible while still showing motion.
                        <span className="cairn-thinking cairn-thinking-inline" aria-label="Still working">
                          <span className="cairn-thinking-dot" />
                          <span className="cairn-thinking-dot" />
                          <span className="cairn-thinking-dot" />
                        </span>
                      )}
                    </span>
                  ) : (
                    <span className="cairn-thinking" aria-label="Thinking">
                      <span className="cairn-thinking-dot" />
                      <span className="cairn-thinking-dot" />
                      <span className="cairn-thinking-dot" />
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {realtimeActive ? (
            <div className="cairn-rt-bar">
              <span className={`cairn-rt-dot cairn-rt-dot-${status}`} />
              <span className="cairn-rt-label">{statusLabel[status]}</span>
              <div className="cairn-rt-controls">
                <button
                  type="button"
                  className={
                    status === "rt-speaking" ? "cairn-icon-btn cairn-icon-btn-speaking" : "cairn-icon-btn"
                  }
                  aria-label={rtMicMuted ? "Unmute microphone" : "Mute microphone"}
                  onClick={toggleRtMic}
                >
                  {rtMicMuted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
                <button
                  type="button"
                  className={
                    status === "rt-speaking" ? "cairn-icon-btn cairn-icon-btn-speaking" : "cairn-icon-btn"
                  }
                  aria-label={rtSpeakerMuted ? "Unmute speaker" : "Mute speaker"}
                  onClick={toggleRtSpeaker}
                >
                  {rtSpeakerMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                </button>
                <button type="button" className="cairn-icon-btn cairn-icon-btn-end" aria-label="End conversation" onClick={endRealtime}>
                  <PhoneOff size={16} />
                </button>
              </div>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = question.trim();
                if (trimmed) void ask(trimmed);
              }}
            >
              <div className="cairn-input-row">
                <input
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="What do you need help with?"
                  aria-label={`Ask ${persona} a question`}
                  disabled={recording || touring}
                  autoFocus
                />
                {realtimeUrl && micSupported && (
                  <button
                    type="button"
                    className="cairn-icon-btn"
                    aria-label="Start realtime conversation"
                    onClick={() => void startRealtime()}
                    disabled={busy || recording}
                  >
                    <PhoneCall size={16} />
                  </button>
                )}
                {transcribeEndpoint && micSupported && (
                  <button
                    type="button"
                    className={recording ? "cairn-icon-btn cairn-icon-btn-recording" : "cairn-icon-btn"}
                    aria-label={recording ? "Stop recording" : "Ask by voice"}
                    onClick={() => (recording ? stopRecording() : void startRecording())}
                    disabled={touring}
                  >
                    {recording ? <Square size={16} /> : <Mic size={16} />}
                  </button>
                )}
                <button
                  type="submit"
                  className="cairn-send"
                  aria-label="Send"
                  disabled={!question.trim() || busy || recording}
                >
                  {asking ? <Loader2 size={16} className="cairn-spin" /> : <Send size={16} />}
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </>
  );
}

const MAX_HISTORY_TURNS = 8; // 4 exchanges — matches the same cap the realtime relay uses server-side

/** Best-effort text form of a raw (unvalidated) verb response for the
 * conversation-history log — not shown to the user, just fed back to the
 * model on later turns. Deliberately loose/defensive rather than a full
 * schema parse: a malformed field here just makes for a slightly less
 * useful memory entry, never a UI action, so it doesn't need the strict
 * validation executeVerbResponse already does for the real thing. */
function summarizeVerbForHistory(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "(no response)";
  const v = raw as Record<string, unknown>;
  if (typeof v.text === "string" && v.text) return v.text;
  switch (v.verb) {
    case "highlight":
    case "open":
      return `(highlighted ${String(v.target)})`;
    case "navigate":
      return `(navigated to ${String(v.route)})`;
    case "do":
      return `(ran ${String(v.action)}${v.target ? ` on ${String(v.target)}` : ""})`;
    case "tour":
      return Array.isArray(v.steps) ? v.steps.map((s: { text?: string }) => s.text ?? "").join(" ") : "(tour)";
    case "click":
      return `(clicked ${String(v.target)})`;
    case "fill":
      return `(typed "${String(v.value)}" into ${String(v.target)})`;
    case "read":
      return `(read ${String(v.target)})`;
    case "call_tool":
      return `(called ${String(v.name)})`;
    case "drag":
      return `(dragged ${String(v.target)} to ${String(v.to)})`;
    case "select":
      return `(selected "${String(v.value)}" in ${String(v.target)})`;
    case "key":
      return `(pressed ${String(v.key)}${v.target ? ` on ${String(v.target)}` : ""})`;
    case "batch":
      return Array.isArray(v.actions) ? `(${v.actions.length} steps: ${v.actions.map((a: { verb?: string }) => a.verb).join(", ")})` : "(batch)";
    default:
      return "(no response)";
  }
}

/**
 * Renders text as a sequence of spans that light up in order — a caption
 * "sweep" that reads like the agent is speaking it, whether or not audio is
 * actually playing right now. This is a pacing *estimate* (staggered by
 * word position, capped so long answers don't take forever), not synced to
 * real TTS word timestamps — Deepgram's streaming API doesn't hand those to
 * the client today, so a true audio-locked sync isn't wired up anywhere in
 * this codebase yet.
 */
function renderCaptionWords(text: string) {
  const words = text.split(" ");
  return words.map((word, i) => (
    <span key={i} className="cairn-word" style={{ animationDelay: `${Math.min(i * 55, 2800)}ms` }}>
      {word}
      {i < words.length - 1 ? " " : ""}
    </span>
  ));
}

function CairnMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <rect x="7" y="12.5" width="6" height="2.6" rx="0.5" fill="currentColor" />
      <rect x="4.5" y="8.5" width="11" height="2.6" rx="0.5" fill="currentColor" opacity="0.75" />
      <rect x="8.2" y="4.5" width="3.6" height="2.6" rx="0.5" fill="currentColor" opacity="0.5" />
    </svg>
  );
}

// Real-time lifecycle logging — every message received, every decision made
// about it (played, spoken, dropped, and why), every state transition. Added
// specifically so a live session's actual behavior is visible in the browser
// console instead of only inferable from symptoms after the fact — every bug
// found and fixed in this file today was diagnosed from screenshots and
// terminal output because nothing like this existed before. `[cairn rt]` is
// the tag to filter on. Deliberately excludes per-audio_chunk noise (dozens
// of chunks per turn would flood the console) — chunk activity shows up as
// a one-line count at speaking_end/turn_complete instead.
function rtLog(event: string, details?: Record<string, unknown>): void {
  if (details) console.log("[cairn rt]", event, details);
  else console.log("[cairn rt]", event);
}

// ---------------------------------------------------------------------------
// Audio helpers (real-time PCM16 capture — standard Web Audio API patterns)
// ---------------------------------------------------------------------------

function downsampleTo16k(input: Float32Array, inputSampleRate: number): Float32Array {
  const targetRate = 16000;
  if (inputSampleRate === targetRate) return input;
  const ratio = inputSampleRate / targetRate;
  const outLength = Math.round(input.length / ratio);
  const result = new Float32Array(outLength);
  let offsetResult = 0;
  let offsetInput = 0;
  while (offsetResult < outLength) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i++) {
      accum += input[i];
      count++;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetInput = nextOffsetInput;
  }
  return result;
}

function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buffer;
}

const COPILOT_STYLES = `
@keyframes cairn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  70% { box-shadow: 0 0 0 10px rgba(239, 68, 68, 0); }
}
@keyframes cairn-pulse-green {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.4); }
  70% { box-shadow: 0 0 0 10px rgba(16, 185, 129, 0); }
}
@keyframes cairn-pulse-indigo {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4); }
  70% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
}
@keyframes cairn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes cairn-rt-dot {
  0%, 100% { opacity: 0.5; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}
@keyframes cairn-bubble-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes cairn-word-sweep {
  0% { opacity: 0.35; text-shadow: none; }
  35% { opacity: 1; color: #4f46e5; text-shadow: 0 0 10px rgba(99, 102, 241, 0.45); }
  100% { opacity: 1; color: inherit; text-shadow: none; }
}
@keyframes cairn-thinking-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 0.9; transform: translateY(-3px); }
}
.cairn-glow {
  animation: cairn-pulse-indigo 1.1s ease-out 2;
  outline: 2px solid #6366f1;
  outline-offset: 3px;
  border-radius: 8px;
}
.cairn-spin {
  animation: cairn-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .cairn-fab, .cairn-panel, .cairn-bubble, .cairn-word, .cairn-thinking-dot {
    animation: none !important;
    transition: none !important;
  }
}

.cairn-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  width: 52px;
  height: 52px;
  border-radius: 999px;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #14151b;
  color: white;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.cairn-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
}
.cairn-fab-speaking {
  box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.22), 0 6px 20px rgba(0, 0, 0, 0.25);
  animation: cairn-pulse-green 1.2s ease-out infinite;
}

/* One unified card — title, conversation, and input all live inside the
   same bounded, padded container instead of floating as independent
   fixed-position pieces. That "everything floats separately" approach
   kept producing new collisions (title vs input, send button vs the
   close FAB) every time one piece's position changed; grouping them
   under one panel with real internal spacing removes that whole class
   of bug at the source. */
.cairn-panel {
  position: fixed;
  right: 20px;
  bottom: 92px;
  z-index: 2147483000;
  width: min(340px, calc(100vw - 40px));
  max-height: 480px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  background: rgba(255, 255, 255, 0.96);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
  border-radius: 20px;
  box-shadow: 0 20px 50px rgba(15, 15, 25, 0.16), 0 2px 8px rgba(15, 15, 25, 0.06);
  font: 13.5px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
  animation: cairn-panel-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
@keyframes cairn-panel-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
.cairn-panel::-webkit-scrollbar {
  width: 0;
}

.cairn-stack {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.cairn-bubble {
  max-width: 92%;
  font-size: 13.5px;
  line-height: 1.5;
  color: #0b0d12;
  animation: cairn-bubble-in 0.2s ease-out;
}
.cairn-bubble-user {
  align-self: flex-end;
  text-align: right;
  color: #33384a;
}
.cairn-bubble-agent {
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.cairn-bubble-text {
  white-space: pre-wrap;
}
.cairn-bubble-past {
  opacity: 0.55;
}
.cairn-word {
  display: inline-block;
  animation: cairn-word-sweep 0.4s ease forwards;
}
.cairn-chip {
  align-self: flex-start;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: rgba(11, 13, 18, 0.48);
}
.cairn-history-toggle {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 2px 8px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: rgba(11, 13, 18, 0.4);
  cursor: pointer;
  border-radius: 999px;
  transition: background 0.15s ease, color 0.15s ease;
}
.cairn-history-toggle:hover {
  background: rgba(11, 13, 18, 0.05);
  color: rgba(11, 13, 18, 0.6);
}
.cairn-thinking {
  display: inline-flex;
  gap: 4px;
  padding: 2px 0;
}
.cairn-thinking-inline {
  margin-left: 6px;
  vertical-align: middle;
}
.cairn-thinking-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: rgba(11, 13, 18, 0.4);
  animation: cairn-thinking-bounce 1.1s ease-in-out infinite;
}
.cairn-thinking-dot:nth-child(2) { animation-delay: 0.15s; }
.cairn-thinking-dot:nth-child(3) { animation-delay: 0.3s; }

.cairn-input-row {
  display: flex;
  gap: 7px;
  align-items: center;
}
.cairn-input-row input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 10px 14px;
  border: none;
  border-radius: 999px;
  font: inherit;
  background: rgba(11, 13, 18, 0.045);
  color: #0b0d12;
  transition: background 0.15s ease, box-shadow 0.15s ease;
}
.cairn-input-row input::placeholder {
  color: rgba(11, 13, 18, 0.4);
}
.cairn-input-row input:disabled {
  opacity: 0.55;
}
.cairn-input-row input:focus {
  outline: none;
  background: rgba(11, 13, 18, 0.06);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.16);
}
.cairn-icon-btn {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  background: rgba(11, 13, 18, 0.045);
  color: #33384a;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}
.cairn-icon-btn:hover {
  background: rgba(11, 13, 18, 0.09);
  transform: translateY(-1px);
}
.cairn-icon-btn-recording {
  background: #ef4444;
  border-color: #ef4444;
  color: white;
  animation: cairn-pulse 1.4s ease-out infinite;
}
.cairn-icon-btn-speaking {
  background: #10b981;
  border-color: #10b981;
  color: white;
  animation: cairn-pulse-green 1.2s ease-out infinite;
}
.cairn-icon-btn-end {
  background: #ef4444;
  border-color: #ef4444;
  color: white;
}
.cairn-send {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: none;
  background: #14151b;
  color: white;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.cairn-send:hover:not(:disabled) {
  transform: translateY(-1px);
}
.cairn-send:disabled {
  background: rgba(11, 13, 18, 0.12);
  color: rgba(11, 13, 18, 0.35);
  box-shadow: none;
  cursor: not-allowed;
}

.cairn-rt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 999px;
  background: rgba(11, 13, 18, 0.045);
}
.cairn-rt-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #6366f1;
  animation: cairn-rt-dot 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.cairn-rt-dot-rt-speaking {
  background: #10b981;
}
.cairn-rt-dot-rt-thinking {
  background: #f59e0b;
}
.cairn-rt-label {
  flex: 1;
  font-size: 12.5px;
  color: #33384a;
}
.cairn-rt-controls {
  display: flex;
  gap: 6px;
}
`;

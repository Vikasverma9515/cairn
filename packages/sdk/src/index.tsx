"use client";

import type React from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Loader2,
  Mic,
  MicOff,
  PhoneCall,
  PhoneOff,
  Send,
  Settings2,
  Square,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { classifyUiPattern, deriveStructureSignals, isTerminalVerb, safeParseVerbResponse, type CriticVerdict, type HistoryTurn as HistoryEntry, type Plan, type ProgressLedger, type Task, type TourStep, type VerbResponse } from "@cairnvibe/core";
import { driveAgentLoop, looksMultiStep } from "./agent-loop";
import { collectVisible } from "./context-collector";
import { hideCursor } from "./cursor-overlay";
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
  // Starts at the same safe default on both server and client's first
  // render — same hydration-mismatch reason `micSupported` below does this
  // — then, once actually restored from sessionStorage post-mount (see the
  // dedicated restore effect further down), flips to whatever a real page
  // reload (a host app's own mutation handler, e.g. — see
  // loadPersistedConversation's own doc comment) had showing a moment ago,
  // so a real reload never again looks like the conversation simply ended.
  const [open, setOpen] = useState(false);
  // Fades the synthetic cursor out once the panel closes (or the widget
  // itself unmounts) instead of leaving it sitting visible on the page.
  useEffect(() => {
    if (!open) hideCursor();
    return () => hideCursor();
  }, [open]);
  // Collapsed by default so the panel only ever shows the current exchange
  // — the full archived transcript (built up over a long conversation)
  // stays out of the way behind an explicit toggle instead of always being
  // visible inline, which made the panel grow uncomfortably tall.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  // Starts at DEFAULT_SETTINGS on both server and client's first render —
  // same hydration-safety reason `open`/`micSupported` do this — then, once
  // actually restored from localStorage post-mount, flips to whatever this
  // person last configured (see the dedicated restore effect below).
  const [settings, setSettings] = useState<CairnSettings>(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
  const [transcript, setTranscript] = useState<{ id: number; role: "user" | "agent"; text: string; generation?: number }[]>([]);
  const transcriptIdRef = useRef(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Mirror the values archiveCurrentExchange needs to read from inside
  // stale closures (the realtime WebSocket's onmessage handler is created
  // once per call and doesn't see later renders' state directly — same
  // reason the rest of the realtime path already uses refs like
  // rtStateRef instead of reading state).
  const userCaptionRef = useRef<string>("");
  const answerRef = useRef<string | null>(null);
  /**
   * Real, live-reported bug this closes: a fast back-and-forth voice
   * conversation could show one question's answer displayed next to a
   * LATER, unrelated question — or lose an answer entirely — because the
   * live `caption`/`answer` pair was archived (or overwritten) purely on
   * "a new 'final' arrived," with no way to tell whether the CURRENT
   * `answer` state actually belonged to the CURRENT `caption` or was a
   * slow-arriving reply to an OLDER question that just hadn't landed yet.
   * This tracks which turn's own server-assigned generation the currently
   * DISPLAYED caption/answer pair actually belongs to — set the instant a
   * new "final" arrives (before caption is even updated), so a reply that
   * shows up late for an OLDER generation can be told apart from the
   * genuinely current one and placed back where it actually belongs
   * (see the "final"/"verb" handlers below) instead of either overwriting
   * the wrong exchange or vanishing.
   */
  const rtLiveGenerationRef = useRef<number | null>(null);
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

  // Real, live-reported gap this closes: on a real phone, opening the full
  // panel (settings FAB, chat-bubble stack, the rt-bar's own mic/speaker/
  // end-call row) just to start a call, THEN having the movie caption
  // ALSO show on top of all of it, is exactly the "taking so much space"
  // complaint — confirmed live against a real screenshot. Same 480px cutoff
  // CSS already uses for the mobile tap-to-talk form swap, kept in sync
  // here as the one JS-side source of truth for click BEHAVIOR (not just
  // layout, which stays CSS-only for the hydration-safety reason
  // `micSupported` above already established — this one genuinely needs a
  // real, post-mount width check because a click handler has to decide
  // what to DO, not just how to look).
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 480px)");
    setIsNarrowViewport(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setIsNarrowViewport(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Restores a conversation that survived a real page reload — same
  // hydration-safety reason as `micSupported` just above: `open`/`answer`/
  // `lastQuestion`/`transcript` all start at their normal empty defaults on
  // both server and client's first render (matching what SSR produced), and
  // only flip to whatever sessionStorage actually holds here, post-mount.
  // Real, live-verified bug this closes: a host app's own mutation handler
  // calling `window.location.reload()` (this SDK's own demo app does this
  // after several real actions, e.g. moving a kanban card) tears down the
  // entire React tree, this widget included — every bit of visible
  // conversation state reset to nothing, making an in-progress conversation
  // look like it had simply ended the instant the host page happened to
  // reload, even though nothing about the CONVERSATION itself was over.
  useEffect(() => {
    const persisted = loadPersistedConversation();
    if (!persisted) return;
    setOpen(persisted.open);
    setAnswer(persisted.answer);
    setLastQuestion(persisted.lastQuestion);
    setTranscript(persisted.transcript);
    historyRef.current = reconstructHistoryFromPersisted(persisted);
    // Starts past the restored transcript's own highest id — otherwise the
    // very next archived entry would reuse an id already on screen, a real
    // duplicate-React-key bug (React silently confuses which DOM node is
    // which when two list items share a key).
    if (persisted.transcript.length > 0) {
      transcriptIdRef.current = Math.max(...persisted.transcript.map((t) => t.id)) + 1;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Same post-mount restore pattern as the conversation above, for the
  // separate settings store (localStorage, see loadSettings's own comment
  // for why that's the right storage for a preference vs. a conversation).
  useEffect(() => {
    setSettings(loadSettings());
  }, []);

  // Persists on every change, skipping the initial mount render for the
  // identical reason the conversation-persist effect below does: that first
  // call is always tied to DEFAULT_SETTINGS, captured before the restore
  // effect above's setState has landed — persisting it would overwrite a
  // real, just-restored preference with the plain defaults for one tick.
  const skippedSettingsMountPersistRef = useRef(false);
  useEffect(() => {
    if (!skippedSettingsMountPersistRef.current) {
      skippedSettingsMountPersistRef.current = true;
      return;
    }
    saveSettings(settings);
  }, [settings]);

  // A widget-scoped "no animations" preference has to reach further than
  // this component's own JSX can: the synthetic cursor overlay (see
  // cursor-overlay.ts) is appended directly to <body>, outside this
  // component's tree entirely, so a class on the panel/fab alone would
  // never reach it. Toggling a class on <html> is the one place a plain
  // CSS descendant selector reaches every piece the widget draws,
  // regardless of where each one actually mounts.
  useEffect(() => {
    document.documentElement.classList.toggle("cairn-reduce-motion", settings.reduceMotion);
    return () => document.documentElement.classList.remove("cairn-reduce-motion");
  }, [settings.reduceMotion]);

  function updateSetting<K extends keyof CairnSettings>(key: K, value: CairnSettings[K]) {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }

  function clearConversation() {
    setTranscript([]);
    setLastQuestion(null);
    setAnswer(null);
    setCaption("");
    historyRef.current = [];
    transcriptIdRef.current = 0;
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(CONVERSATION_STORAGE_KEY);
      } catch {
        // Storage unavailable — the in-memory state above is already cleared, which is what actually matters.
      }
    }
  }

  const asking = status === "asking";
  const recording = status === "recording";
  const realtimeActive = status.startsWith("rt-");
  const touring = tourStep !== null;
  const busy = asking || status === "rt-thinking" || touring;
  // On a real phone, when voice is even configured for this deployment,
  // the main FAB itself IS the talk button — no panel, no settings icon,
  // no bubble stack, just the FAB plus the movie caption. A deployment
  // with no realtimeUrl/no mic support falls through to the FAB's normal
  // open/close behavior regardless of viewport width, so a typed-only
  // integration never loses its only way in on a phone.
  const mobileVoicePrimary = isNarrowViewport && !!realtimeUrl && micSupported;

  // Movie-caption color adaptation (see sampleAncestorBackgroundColor's own
  // doc comment) — sampled once per call, not on every render/word: the
  // host page's real background behind a fixed-position overlay doesn't
  // change mid-conversation, so re-sampling continuously would just spend
  // cycles re-deriving the same answer. White is the starting default (most
  // real host apps + this widget's own dark FAB skew dark), corrected the
  // instant a real ancestor color is found.
  const movieCaptionRef = useRef<HTMLDivElement | null>(null);
  const [movieCaptionColor, setMovieCaptionColor] = useState("#ffffff");
  useEffect(() => {
    if (!realtimeActive || typeof document === "undefined") return;
    // The caption element itself isn't mounted on the FIRST render where
    // realtimeActive just became true (it renders conditionally on having
    // real text too) — a rAF gives the DOM one paint to catch up before
    // sampling, cheap insurance against reading a stale/null ref.
    const raf = requestAnimationFrame(() => {
      const anchor = movieCaptionRef.current?.parentElement ?? null;
      const sampled = sampleAncestorBackgroundColor(anchor);
      if (sampled) setMovieCaptionColor(pickReadableCaptionColor(sampled.r, sampled.g, sampled.b));
    });
    return () => cancelAnimationFrame(raf);
  }, [realtimeActive]);

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

  // Persists the visible conversation to sessionStorage on every change, so
  // a host app's own `window.location.reload()` (e.g. after a board-card
  // move — see loadPersistedConversation's own comment for the full story)
  // doesn't make an in-progress conversation look like it simply ended.
  // Skips its own very first (mount) invocation on purpose: that call is
  // always tied to the initial render's plain defaults (open:false,
  // transcript:[], ...) — captured before the restore effect above's
  // setState calls have actually landed — so persisting it would clobber a
  // real, just-restored conversation with empty state for one tick, right
  // before the corrective post-restore render fixes it back. Skipping costs
  // nothing on a genuinely fresh session (there's nothing to persist yet).
  const skippedMountPersistRef = useRef(false);
  useEffect(() => {
    if (!skippedMountPersistRef.current) {
      skippedMountPersistRef.current = true;
      return;
    }
    savePersistedConversation({ transcript, lastQuestion, answer, open });
  }, [transcript, lastQuestion, answer, open]);

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
  function archiveText(role: "user" | "agent", text: string, generation?: number) {
    if (!text) return;
    setTranscript((prev) => [...prev, { id: transcriptIdRef.current++, role, text, generation }]);
  }

  /** `generation` tags the OUTGOING exchange with the turn it actually
   * belonged to (rtLiveGenerationRef.current, read BEFORE the caller
   * updates it for the incoming turn) — undefined for the typed/
   * recording paths, which never set that ref and don't have this race. */
  function archiveCurrentExchange(generation?: number) {
    archiveText("user", userCaptionRef.current, generation);
    archiveText("agent", answerRef.current ?? "", generation);
  }

  /**
   * The other half of the fix rtLiveGenerationRef exists for: a reply
   * that arrives for a generation OLDER than the one currently live —
   * its own question has therefore already been archived (a newer
   * "final" beat it there) — no longer gets silently dropped or shown
   * against the wrong, newer question. Finds that question's own
   * archived entry by generation and inserts the real answer directly
   * after it, exactly where it chronologically belongs, instead of
   * either overwriting whatever's currently live or vanishing. A no-op
   * (falls through to the caller's own fallback) if no matching
   * question is found — a defensive case, not expected in practice.
   */
  function insertArchivedAnswer(generation: number, text: string): boolean {
    if (!text) return false;
    let inserted = false;
    setTranscript((prev) => {
      const idx = prev.findIndex((e) => e.generation === generation && e.role === "user");
      if (idx === -1) return prev;
      // Don't insert a second answer for a question that already has one —
      // a genuine duplicate delivery (a reconnect, a retried send) should
      // never show the same exchange's answer twice.
      const alreadyAnswered = prev[idx + 1]?.generation === generation && prev[idx + 1]?.role === "agent";
      if (alreadyAnswered) return prev;
      inserted = true;
      const entry = { id: transcriptIdRef.current++, role: "agent" as const, text, generation };
      return [...prev.slice(0, idx + 1), entry, ...prev.slice(idx + 1)];
    });
    return inserted;
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
        openDialog: liveScan.openDialog,
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
        } else if (speakEndpoint && settings.voiceReplies) {
          await speakAndWait(step.text);
        } else {
          // No TTS configured, or the user turned narration off in
          // Settings — either way pace by an estimate of reading time
          // instead of racing through every step instantly.
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
            openDialog: liveScan.openDialog,
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
        ? async ({ verb, observation, terminal }) => {
            // Same real latency guard as realtime-server.ts's own runCritic
            // closure (see its doc comment) — driveAgentLoop now checks a
            // terminal verb too, and forcing a Plan into existence just to
            // critic-check an ordinary one-turn answer ("hello") would add
            // a real, unnecessary round trip even for a deployment that
            // opted into Planner/Critic. Skip when nothing so far actually
            // signaled a multi-step goal.
            if (terminal && !plan && !planPromise) return undefined;
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
    if (!speakEndpoint || !text.trim() || !settings.voiceReplies) return;
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
    if (!speakEndpoint || !text.trim() || !settings.voiceReplies) return;
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
    // A fresh connection has no prior turn's generation to speak of —
    // without this, a lingering value from an EARLIER call (ended and
    // restarted) could tag this call's first archived exchange with an
    // unrelated old generation number.
    rtLiveGenerationRef.current = null;

    /**
     * Real, live-reported bug this pair closes: `userCaptionRef.current`/
     * `answerRef.current` used to be kept in sync purely via a `useEffect`
     * watching `userCaption`/`answer` — which only runs AFTER a render
     * commits. Two realtime WS messages arriving close enough together
     * that React never gets a render in between (confirmed live: two
     * "final" transcripts dispatched back to back, with no delay, is
     * enough on its own) means the SECOND one's `archiveCurrentExchange()`
     * reads a ref that's still one full turn behind — archiving with an
     * effectively empty caption (archiveText silently skips empty text),
     * so that turn's own question, and any answer that later tries to
     * attach to it, vanishes from the transcript entirely rather than
     * merely being mis-paired. These wrappers make the ref the real,
     * synchronously-updated source of truth for exactly the realtime
     * turn flow (every setCaption/setAnswer call inside this function,
     * including ws.onmessage below) — the React state update alongside it
     * is still what drives the actual re-render, this only removes the
     * one-effect-cycle lag `archiveCurrentExchange` could ever observe.
     * Scoped to realtime specifically — the typed/tour paths call
     * setCaption/setAnswer directly and are never subject to this exact
     * race (no concurrent, unpaced WS messages involved there).
     */
    function setRtCaption(text: string) {
      userCaptionRef.current = text;
      setCaption(text);
    }
    function setRtAnswer(text: string | null) {
      answerRef.current = text;
      setAnswer(text);
    }

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
        setRtCaption("");
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
          setRtAnswer("That's taking longer than expected — try asking again.");
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
          setRtCaption(msg.text);
        } else if (msg.type === "final") {
          rtLog("final transcript", { text: msg.text, generation: msg.generation });
          rtLastFinalGenerationRef.current = typeof msg.generation === "number" ? msg.generation : 0;
          // Tag the OUTGOING exchange with the generation it actually
          // belonged to (read BEFORE overwriting it below) — this is what
          // lets a same-generation reply that arrives late find its real
          // question again instead of showing up next to this NEW one.
          archiveCurrentExchange(rtLiveGenerationRef.current ?? undefined);
          rtLiveGenerationRef.current = typeof msg.generation === "number" ? msg.generation : null;
          setRtCaption(msg.text);
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
          setRtAnswer(null);
          setRtStatus("rt-thinking");
          armThinkingWatchdog();
        } else if (msg.type === "verb") {
          const parsedStep = safeParseVerbResponse(msg.verb);
          if (isStaleRtMessage(msg)) {
            // Real, live-reported bug this closes: previously just
            // `return`ing here either silently lost this turn's real
            // answer, or — if `answer` state hadn't been cleared since an
            // even OLDER turn — let a stale reply sit there and get
            // archived alongside a later, unrelated question on the NEXT
            // final. A terminal verb's real text was always going to
            // become a visible reply; recover it into the transcript
            // slot it actually belongs to (right after its own archived
            // question — see insertArchivedAnswer) instead of dropping it
            // or misattributing it. A CONTINUING step has no such text
            // worth recovering (internal progress, not a real answer) and
            // is still just dropped here, same as every other stale
            // message type below.
            if (parsedStep && isTerminalVerb(parsedStep) && typeof msg.generation === "number") {
              const staleText = "text" in parsedStep ? parsedStep.text : undefined;
              if (staleText) insertArchivedAnswer(msg.generation, staleText);
            }
            return;
          }
          rtLog("verb received", { verb: msg.verb?.verb, generation: msg.generation });
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
            setRtAnswer(summarizeVerbForHistory(msg.verb));
            setLoopWorking(true);
            // Real, live-found bug: armThinkingWatchdog() only ever fired
            // once, on the turn's own "final" message, giving the WHOLE
            // multi-step turn one shared 20s budget — Executor + Planner +
            // Critic for step 1, then the same again for step 2, and so
            // on. Directly measured live: one single non-terminal step's
            // own Executor+Planner+Critic chain alone took ~14s (11.5s +
            // 1.5s + 1.1s) — a real, multi-step goal needing two or three
            // such steps blows straight through 20s even though each
            // individual step is proof of genuine progress, not a stall.
            // Re-arming here — once per continuing step, not once per
            // turn — gives every step its own fresh budget, so the
            // watchdog only ever fires on a step that's ACTUALLY stuck
            // (no verb/final/speaking_start arriving at all), matching
            // what its own fallback message ("taking longer than
            // expected") is supposed to mean.
            armThinkingWatchdog();
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
          // Real, live-reported bug this closes: every OTHER turn-scoped
          // message type (verb/speaking_start/audio_chunk/speaking_end/
          // turn_complete) already drops a stale one via isStaleRtMessage
          // — "error" was the one type that never did. A late failure for
          // a turn the user had already moved past (a rate-limited LLM
          // call, most commonly) unconditionally overwrote whatever the
          // CURRENT turn was showing — "Something went wrong on my end"
          // landing next to a later, unrelated question, or a real
          // in-progress caption/answer getting wiped by a failure that
          // belonged to an earlier question entirely. Server now attaches
          // `generation` to every TURN-scoped error (realtime-server.ts);
          // a connection-level failure (Deepgram's own socket dying, a
          // malformed message) still carries none and is deliberately
          // never dropped here — isStaleRtMessage only ever treats an
          // ABSENT generation as current, exactly the pre-existing
          // semantics every other handler below already relies on.
          if (isStaleRtMessage(msg)) return;
          rtLog("server error", { message: msg.message });
          // Must actually unstick the turn, not just show the message —
          // otherwise the mic never resumes and the session is stuck
          // exactly the way a silently-dropped response used to leave it.
          disarmThinkingWatchdog();
          setLoopWorking(false);
          setRtAnswer(msg.message ?? "Something went wrong.");
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
            setRtCaption("");
          }
        }
      };

      ws.onerror = () => {
        rtLog("connection error");
        setRtAnswer("Couldn't connect to the realtime voice service.");
        endRealtime();
      };
      ws.onclose = (closeEvent) => {
        rtLog("connection closed", { code: closeEvent.code, reason: closeEvent.reason, wasIdle: rtStateRef.current === "idle" });
        if (rtStateRef.current !== "idle") endRealtime();
      };
    } catch {
      setRtAnswer("Couldn't access the microphone — check your browser's permission for this site.");
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

  const panelVars: PanelCSSVars = {
    "--cairn-w": settings.density === "compact" ? "272px" : "312px",
    "--cairn-pad": settings.density === "compact" ? "11px" : "15px",
    "--cairn-gap": settings.density === "compact" ? "7px" : "11px",
    "--cairn-btn": settings.density === "compact" ? "29px" : "33px",
    "--cairn-font": settings.fontSize === "small" ? "12px" : settings.fontSize === "large" ? "14.5px" : "12.75px",
  };
  const posClass = settings.position === "left" ? " cairn-pos-left" : "";

  return (
    <>
      <style suppressHydrationWarning dangerouslySetInnerHTML={{ __html: COPILOT_STYLES }} />
      {open && (
        // A second, smaller floating control next to the main FAB, not a
        // row inside the panel — the panel's own vertical space stays 100%
        // conversation/transcript, nothing else. Only rendered while open:
        // settings are about the current session, not something worth a
        // permanent extra button on the closed launcher.
        <button
          type="button"
          className={"cairn-settings-fab" + posClass}
          aria-label={settingsOpen ? "Back to conversation" : "Open settings"}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          {settingsOpen ? <ArrowLeft size={14} /> : <Settings2 size={14} />}
        </button>
      )}
      <button
        className={
          (status === "rt-speaking" ? "cairn-fab cairn-fab-speaking" : mobileVoicePrimary && realtimeActive ? "cairn-fab cairn-fab-live" : "cairn-fab") +
          posClass
        }
        aria-label={
          mobileVoicePrimary
            ? realtimeActive
              ? "End the call"
              : "Start talking"
            : open
              ? `Close ${persona} help`
              : `Open ${persona} help`
        }
        onClick={() => {
          // Real, live-reported gap this closes: on a real phone, tapping
          // this button used to open the full panel — settings icon, chat-
          // bubble stack, the rt-bar's own mic/speaker/end-call row — and
          // THEN the movie caption showed on top of all of it too. On a
          // narrow viewport with voice configured, this button skips the
          // panel entirely and IS the talk toggle; open never becomes
          // true, so the panel (and everything in it) simply never
          // renders — the caption, already independent of `open`, is the
          // only thing left on screen.
          if (mobileVoicePrimary) {
            if (realtimeActive) endRealtime();
            else void startRealtime();
            return;
          }
          setOpen((v) => !v);
        }}
      >
        {mobileVoicePrimary ? realtimeActive ? <PhoneOff size={20} /> : <CairnMark /> : open ? <X size={22} /> : <CairnMark />}
      </button>
      {open && (
        <div className={"cairn-panel" + posClass} style={panelVars} role="dialog" aria-label={`${persona} help panel`} ref={panelRef}>
          {settingsOpen && (
            <SettingsView
              settings={settings}
              updateSetting={updateSetting}
              onClear={clearConversation}
              showVoiceReplies={!!speakEndpoint}
              hasHistory={transcript.length > 0 || !!answer || !!lastQuestion}
            />
          )}

          {!settingsOpen && (transcript.length > 0 || userCaption || answer || busy) && (
            <div className="cairn-stack">
              {transcript.length > 0 && !realtimeActive && (
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
              {
                // A live call reads as one continuous transcript, not a
                // collapsed history behind a toggle — the toggle above is
                // hidden for the same reason, this is what makes hiding it
                // not just leave the turns unreachable.
                (historyExpanded || realtimeActive) &&
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
                    <span className="cairn-bubble-text" aria-label={answer}>
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

          {!settingsOpen && (realtimeActive ? (
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
            // On a narrow viewport with voice configured, the FAB itself is
            // the talk toggle (see mobileVoicePrimary above) and this panel
            // never opens at all — so this form only ever renders on a
            // wide/desktop viewport, or on a narrow one where voice genuinely
            // isn't available, where it's correctly still the only way in.
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
          ))}
        </div>
      )}
      {realtimeActive &&
        (() => {
          // Real, live-requested shape: "feels like a movie transcript" —
          // ONE line at a time (whoever's actually talking right now), not
          // a scrolling log, no bubble/box, no avatar — open captions sit
          // directly over the page the same way they sit over a film
          // frame. Independent of whether the chat panel itself is open:
          // an ambient caption during a live call is the whole point, not
          // something tucked behind a click.
          const speakingNow = status === "rt-speaking";
          const movieCaptionText = speakingNow ? (answer ?? "") : userCaption;
          if (!movieCaptionText) return null;
          return (
            <div className="cairn-movie-caption" ref={movieCaptionRef} aria-live="polite" aria-label={movieCaptionText}>
              {
                // Keyed by the line's own text — a real, deliberate remount
                // per turn, not just a style update: only ONE line is ever
                // on screen (the previous one is simply gone, never stacked
                // underneath), and re-mounting is what makes the slide-up
                // entrance actually replay on every new line instead of
                // only the very first one a call ever shows.
              }
              <div key={movieCaptionText} className="cairn-movie-caption-pill" style={{ color: movieCaptionColor }}>
                <span className={speakingNow ? "cairn-movie-caption-dot cairn-movie-caption-dot-agent" : "cairn-movie-caption-dot"} aria-hidden="true" />
                {renderCaptionWords(movieCaptionText)}
              </div>
            </div>
          );
        })()}
    </>
  );
}

type PanelCSSVars = React.CSSProperties & Record<`--cairn-${string}`, string>;

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="cairn-segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          className={value === opt.value ? "cairn-segmented-btn cairn-segmented-btn-active" : "cairn-segmented-btn"}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={checked ? "cairn-toggle cairn-toggle-on" : "cairn-toggle"}
      onClick={() => onChange(!checked)}
    >
      <span className="cairn-toggle-knob" />
    </button>
  );
}

/**
 * Direct ask: "settings — what can we include, small settings button, that
 * can people configure." Deliberately scoped to settings with a REAL,
 * immediately-visible client-side effect — density/position/font/motion
 * change the panel on the spot, voice-replies gates a real code path
 * (speak()/speakAndWait() above), clear-conversation actually clears real
 * stored state. No placeholder toggles that silently do nothing.
 */
function SettingsView({
  settings,
  updateSetting,
  onClear,
  showVoiceReplies,
  hasHistory,
}: {
  settings: CairnSettings;
  updateSetting: <K extends keyof CairnSettings>(key: K, value: CairnSettings[K]) => void;
  onClear: () => void;
  showVoiceReplies: boolean;
  hasHistory: boolean;
}) {
  return (
    <div className="cairn-settings">
      <div className="cairn-settings-section">
        <div className="cairn-settings-heading">Appearance</div>
        <div className="cairn-settings-row">
          <span className="cairn-settings-label">Size</span>
          <Segmented
            ariaLabel="Widget size"
            value={settings.density}
            onChange={(v) => updateSetting("density", v)}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
            ]}
          />
        </div>
        <div className="cairn-settings-row">
          <span className="cairn-settings-label">Position</span>
          <Segmented
            ariaLabel="Widget position"
            value={settings.position}
            onChange={(v) => updateSetting("position", v)}
            options={[
              { value: "right", label: "Right" },
              { value: "left", label: "Left" },
            ]}
          />
        </div>
        <div className="cairn-settings-row">
          <span className="cairn-settings-label">Text size</span>
          <Segmented
            ariaLabel="Text size"
            value={settings.fontSize}
            onChange={(v) => updateSetting("fontSize", v)}
            options={[
              { value: "small", label: "S" },
              { value: "medium", label: "M" },
              { value: "large", label: "L" },
            ]}
          />
        </div>
      </div>

      {showVoiceReplies && (
        <div className="cairn-settings-section">
          <div className="cairn-settings-heading">Behavior</div>
          <div className="cairn-settings-row">
            <span className="cairn-settings-label">Voice replies</span>
            <Toggle
              ariaLabel="Speak answers aloud"
              checked={settings.voiceReplies}
              onChange={(v) => updateSetting("voiceReplies", v)}
            />
          </div>
        </div>
      )}

      <div className="cairn-settings-section">
        <div className="cairn-settings-heading">Accessibility</div>
        <div className="cairn-settings-row">
          <span className="cairn-settings-label">Reduce motion</span>
          <Toggle
            ariaLabel="Reduce motion and animation"
            checked={settings.reduceMotion}
            onChange={(v) => updateSetting("reduceMotion", v)}
          />
        </div>
      </div>

      <div className="cairn-settings-section">
        <div className="cairn-settings-heading">Privacy</div>
        <button type="button" className="cairn-clear-btn" onClick={onClear} disabled={!hasHistory}>
          <Trash2 size={13} />
          Clear conversation
        </button>
      </div>
    </div>
  );
}

const MAX_HISTORY_TURNS = 8; // 4 exchanges — matches the same cap the realtime relay uses server-side

export const CONVERSATION_STORAGE_KEY = "cairn:conversation:v1";

export interface PersistedConversation {
  transcript: { id: number; role: "user" | "agent"; text: string }[];
  lastQuestion: string | null;
  answer: string | null;
  open: boolean;
}

/**
 * Real, live-reported bug this closes: a host app's own mutation handler
 * calling a real `window.location.reload()` — a common, entirely valid
 * pattern; this SDK's own demo app uses it after several real actions,
 * e.g. moving a kanban card — tears down the ENTIRE React tree, this
 * widget included. Every bit of conversation state (the visible
 * transcript, the current exchange, even whether the panel was open)
 * reset to nothing, making a real, in-progress conversation look like it
 * had simply ended the instant a host page happened to reload — even
 * though nothing about the CONVERSATION itself was actually over.
 * `sessionStorage`, not `localStorage`, is deliberate: it survives
 * exactly a reload/navigation within the same tab — the real scope of
 * "this conversation" — and clears itself once the tab/window actually
 * closes, never lingering into an unrelated later visit the way
 * `localStorage` would.
 */
export function loadPersistedConversation(): PersistedConversation | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(CONVERSATION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const transcript = Array.isArray(parsed.transcript)
      ? parsed.transcript.filter(
          (t: unknown): t is { id: number; role: "user" | "agent"; text: string } =>
            !!t && typeof t === "object" && typeof (t as { id?: unknown }).id === "number" && typeof (t as { text?: unknown }).text === "string" && ((t as { role?: unknown }).role === "user" || (t as { role?: unknown }).role === "agent"),
        )
      : [];
    return {
      transcript,
      lastQuestion: typeof parsed.lastQuestion === "string" ? parsed.lastQuestion : null,
      answer: typeof parsed.answer === "string" ? parsed.answer : null,
      open: Boolean(parsed.open),
    };
  } catch {
    return null; // private browsing, quota, or a genuinely corrupt value — never crash the widget over this
  }
}

export function savePersistedConversation(data: PersistedConversation): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable/full — the conversation just won't survive a reload this time, never worth crashing the widget over.
  }
}

export const SETTINGS_STORAGE_KEY = "cairn:settings:v1";

export interface CairnSettings {
  /** Panel width/padding/icon-button size. "compact" trims the widget down for small screens or users who find the default too roomy. */
  density: "comfortable" | "compact";
  /** Which bottom corner the FAB/panel anchor to. */
  position: "right" | "left";
  /** Base text size inside the panel — a real accessibility control, not decoration. */
  fontSize: "small" | "medium" | "large";
  /** Disables every animation the widget itself draws (panel-in, word-sweep, thinking dots, highlight pulse, cursor). Independent of and in addition to the OS-level prefers-reduced-motion query already respected. */
  reduceMotion: boolean;
  /** Gates the typed/HTTP path's own TTS narration (speak()/speakAndWait(), used for explain answers and tour steps when no live realtime call is open). Never touches an actual realtime voice call — muting narration mid-conversation there would be confusing, not helpful. Meaningless (and hidden in the UI) when the host app never configured speakEndpoint at all. */
  voiceReplies: boolean;
}

export const DEFAULT_SETTINGS: CairnSettings = {
  // Compact by default — direct, repeated ask across two rounds of
  // feedback ("make it smaller," then "make the text and everything
  // small"). Comfortable stays available in Settings for anyone who wants
  // the extra room back.
  density: "compact",
  position: "right",
  fontSize: "medium",
  reduceMotion: false,
  voiceReplies: true,
};

/**
 * `localStorage`, not `sessionStorage` — the deliberate opposite choice
 * from the conversation store just above. A conversation is scoped to
 * "this one visit"; a preference like "I want the compact widget" or "no
 * animations" is scoped to "this person, on this browser, from now on" —
 * it should still be in effect the next time they come back, not reset
 * the moment they close the tab.
 */
export function loadSettings(): CairnSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    // Merged field-by-field against the defaults (not a blind spread) so a
    // value saved by an older widget version that later drops or renames a
    // setting degrades to the new default instead of carrying forward a
    // now-meaningless stored value.
    return {
      density: parsed.density === "compact" ? "compact" : DEFAULT_SETTINGS.density,
      position: parsed.position === "left" ? "left" : DEFAULT_SETTINGS.position,
      fontSize: parsed.fontSize === "small" || parsed.fontSize === "large" ? parsed.fontSize : DEFAULT_SETTINGS.fontSize,
      reduceMotion: typeof parsed.reduceMotion === "boolean" ? parsed.reduceMotion : DEFAULT_SETTINGS.reduceMotion,
      voiceReplies: typeof parsed.voiceReplies === "boolean" ? parsed.voiceReplies : DEFAULT_SETTINGS.voiceReplies,
    };
  } catch {
    return DEFAULT_SETTINGS; // private browsing, quota, or a genuinely corrupt value — never crash the widget over this
  }
}

export function saveSettings(settings: CairnSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable/full — the preference just won't survive this time, never worth crashing the widget over.
  }
}

/**
 * Rebuilds a real seed for `historyRef` (what gets sent to the model on
 * the NEXT typed turn) from a restored transcript — deliberately derived
 * from the same, already-persisted `transcript` rather than separately
 * persisting `historyRef`'s own shape: one real source of truth for "what
 * was actually said," not two that could quietly drift apart. Capped the
 * same way every other history array in this file already is.
 */
export function reconstructHistoryFromPersisted(persisted: PersistedConversation | null): HistoryEntry[] {
  if (!persisted) return [];
  const fromTranscript: HistoryEntry[] = persisted.transcript.map((t) => ({ role: t.role === "agent" ? "assistant" : "user", text: t.text }));
  const live: HistoryEntry[] = [
    ...(persisted.lastQuestion ? [{ role: "user" as const, text: persisted.lastQuestion }] : []),
    ...(persisted.answer ? [{ role: "assistant" as const, text: persisted.answer }] : []),
  ];
  return [...fromTranscript, ...live].slice(-MAX_HISTORY_TURNS);
}

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
// The word-sweep reveal is purely visual — one <span> per word so each can
// carry its own animation-delay. A screen reader has no reason to visit
// dozens of individual one-word nodes to get the same sentence a sighted
// user reads in one glance, so the whole run is hidden from assistive tech
// here; the caller puts the real, complete text on the wrapping element's
// aria-label instead, which is what actually gets announced.
function renderCaptionWords(text: string) {
  const words = text.split(" ");
  return (
    <span aria-hidden="true">
      {words.map((word, i) => (
        <span key={i} className="cairn-word" style={{ animationDelay: `${Math.min(i * 55, 2800)}ms` }}>
          {word}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}

/**
 * Movie-caption color adaptation. The caption overlay (see
 * .cairn-movie-caption below) deliberately carries no background box of its
 * own — real open captions sit directly over whatever's playing — so
 * legibility depends entirely on picking a text color that actually
 * contrasts with what's really behind it, not a fixed light/dark choice
 * that goes invisible the instant the host app's own theme doesn't match.
 *
 * WCAG's own relative-luminance formula (sRGB, gamma-corrected) — real
 * perceptual math, not a naive (r+g+b)/3 average, which misjudges pure
 * blues/reds badly enough to flip the wrong way on real brand colors.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const linear = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** White on a dark background, near-black on a light one — the same real
 * threshold (not the arithmetic midpoint 0.5) real accessible-contrast
 * tooling converges on, since human contrast perception isn't linear in
 * luminance. */
export function pickReadableCaptionColor(r: number, g: number, b: number): string {
  return relativeLuminance(r, g, b) > 0.4 ? "#0a0b0e" : "#ffffff";
}

/** Walks real DOM ancestors from `start` up to `<html>`, reading each one's
 * OWN computed background-color, and returns the first genuinely opaque one
 * found — that's the real color the caption overlay is actually sitting on
 * top of in THIS host page, not a guess. Skips fully/mostly transparent
 * layers (alpha <= 0.5) since those aren't what a viewer's eye actually
 * perceives as "the background." Real limitation, not silently pretended
 * away: an image/gradient/video background has no single computed color at
 * all — getComputedStyle can't see pixels, only declared CSS — so this
 * returns null for that case, and the caller falls back to a fixed choice
 * plus the text-shadow halo every caption gets regardless, the same real
 * technique broadcast captions use to stay legible over footage a flat
 * color guess never could. */
export function sampleAncestorBackgroundColor(start: Element | null): { r: number; g: number; b: number } | null {
  let node: Element | null = start;
  while (node && node !== document.documentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    const match = bg.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
    if (match) {
      const alpha = match[4] !== undefined ? parseFloat(match[4]) : 1;
      if (alpha > 0.5) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) };
    }
    node = node.parentElement;
  }
  return null;
}

// "Waybalance" — three real, irregular stones (an ellipse plus a smaller
// bump, not a rectangle), stacked slightly off-center the way a hiker
// actually balances a trail cairn, instead of the perfectly centered flat
// bars this replaced. Same mark as docs/images/logo.svg and site/index.html's
// nav badge, just currentColor here so it inherits the button's own color.
function CairnMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <ellipse cx="10" cy="14.6" rx="6.1" ry="2.3" fill="currentColor" />
      <ellipse cx="6.3" cy="14.1" rx="2.5" ry="1.6" fill="currentColor" />
      <ellipse cx="9.1" cy="10.4" rx="4.3" ry="2" fill="currentColor" opacity="0.82" />
      <ellipse cx="6.2" cy="10" rx="1.7" ry="1.2" fill="currentColor" opacity="0.82" />
      <ellipse cx="11.7" cy="6.4" rx="2.6" ry="1.6" fill="currentColor" opacity="0.6" />
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
@keyframes cairn-pulse-ember {
  0%, 100% { box-shadow: 0 0 0 0 rgba(224, 122, 63, 0.4); }
  70% { box-shadow: 0 0 0 10px rgba(224, 122, 63, 0); }
}
@keyframes cairn-cursor-arrive {
  0% { transform: translate(-50%, -50%) scale(0.5); opacity: 0.9; }
  100% { transform: translate(-50%, -50%) scale(1.8); opacity: 0; }
}
@keyframes cairn-cursor-pulse {
  0%, 100% { transform: translate(-50%, -50%) scale(1); }
  50% { transform: translate(-50%, -50%) scale(1.12); }
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
  35% { opacity: 1; color: #E07A3F; text-shadow: 0 0 10px rgba(224, 122, 63, 0.45); }
  100% { opacity: 1; color: inherit; text-shadow: none; }
}
@keyframes cairn-thinking-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: translateY(0); }
  40% { opacity: 0.9; transform: translateY(-3px); }
}
.cairn-glow {
  animation: cairn-pulse-ember 1s ease-out 3;
  outline: 3px solid #E07A3F;
  outline-offset: 3px;
  border-radius: 8px;
}
#cairn-cursor .cairn-cursor-dot {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  width: 11px;
  height: 11px;
  border-radius: 999px;
  background: radial-gradient(circle at 32% 32%, #f5a876, #e07a3f 55%, #c7642f 100%);
  box-shadow: 0 2px 6px rgba(224, 122, 63, 0.45);
  animation: cairn-cursor-pulse 1.6s ease-in-out infinite;
}
#cairn-cursor .cairn-cursor-halo {
  position: absolute;
  left: 0;
  top: 0;
  transform: translate(-50%, -50%);
  width: 26px;
  height: 26px;
  border-radius: 999px;
  background: radial-gradient(circle, rgba(224, 122, 63, 0.3) 0%, rgba(224, 122, 63, 0) 72%);
}
#cairn-cursor.cairn-cursor-hover .cairn-cursor-halo {
  animation: cairn-cursor-arrive 0.45s ease-out;
}
.cairn-spin {
  animation: cairn-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .cairn-fab, .cairn-panel, .cairn-bubble, .cairn-word, .cairn-thinking-dot, .cairn-movie-caption-pill,
  #cairn-cursor, #cairn-cursor .cairn-cursor-dot, #cairn-cursor .cairn-cursor-halo {
    animation: none !important;
    transition: none !important;
  }
}
/* The explicit, user-facing twin of the OS-level query just above — set
   from Settings > Accessibility > Reduce motion, applied to <html> because
   the synthetic cursor overlay mounts on <body>, outside this component's
   own tree, so nothing narrower would reach it (see the effect that toggles
   this class in the component for the full reasoning). Reaches the dot/halo
   spans explicitly — a parent's animation:none does not stop a CHILD
   element's own separately-declared animation. */
html.cairn-reduce-motion .cairn-fab,
html.cairn-reduce-motion .cairn-panel,
html.cairn-reduce-motion .cairn-bubble,
html.cairn-reduce-motion .cairn-word,
html.cairn-reduce-motion .cairn-movie-caption-pill,
html.cairn-reduce-motion .cairn-thinking-dot,
html.cairn-reduce-motion .cairn-glow,
html.cairn-reduce-motion #cairn-cursor,
html.cairn-reduce-motion #cairn-cursor .cairn-cursor-dot,
html.cairn-reduce-motion #cairn-cursor .cairn-cursor-halo {
  animation: none !important;
  transition: none !important;
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
.cairn-fab.cairn-pos-left {
  right: auto;
  left: 20px;
}
.cairn-fab-speaking {
  box-shadow: 0 0 0 4px rgba(16, 185, 129, 0.22), 0 6px 20px rgba(0, 0, 0, 0.25);
  animation: cairn-pulse-green 1.2s ease-out infinite;
}
/* The mobile-primary FAB's own "a call is live, tap to end" ring — a
   calmer, steadier signal than the speaking pulse above (that one's still
   used on top of this whenever the agent is actually talking), covering
   the connecting/listening/thinking states this one alone wouldn't. */
.cairn-fab-live {
  box-shadow: 0 0 0 4px rgba(239, 68, 68, 0.22), 0 6px 20px rgba(0, 0, 0, 0.25);
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
  /* Clears the FAB row below it: 20px bottom + 52px fab height + 10px gap
     — the settings FAB sits beside the main one now, not stacked above
     it, so the panel only needs to clear a single row's height. */
  bottom: 82px;
  z-index: 2147483000;
  width: min(var(--cairn-w, 340px), calc(100vw - 40px));
  max-height: 420px;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  gap: var(--cairn-gap, 14px);
  padding: var(--cairn-pad, 18px);
  background: rgba(255, 255, 255, 0.96);
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
  border-radius: 20px;
  box-shadow: 0 20px 50px rgba(15, 15, 25, 0.16), 0 2px 8px rgba(15, 15, 25, 0.06);
  font: var(--cairn-font, 13.5px)/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", sans-serif;
  animation: cairn-panel-in 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.cairn-panel.cairn-pos-left {
  right: auto;
  left: 20px;
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
  gap: 8px;
}
/* Real bubbles, not just aligned/colored text — a floating widget this
   narrow is exactly the case where a bubble still reads as a bubble
   instead of a messenger cliché (a full-width transcript needs the room
   this panel doesn't have). Tail corner (4px vs 14px) on the side that
   faces the other party is what makes the two roles legible as a shape,
   not just a color, at a glance and mid-scroll — the same asymmetry
   iMessage/WhatsApp use. */
.cairn-bubble {
  max-width: 86%;
  font-size: var(--cairn-font, 13.5px);
  line-height: 1.45;
  padding: 7px 11px;
  border-radius: 14px;
  animation: cairn-bubble-in 0.2s ease-out;
}
.cairn-bubble-user {
  align-self: flex-end;
  background: #14151b;
  color: #f2f2f4;
  border-bottom-right-radius: 4px;
}
.cairn-bubble-agent {
  align-self: flex-start;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(11, 13, 18, 0.055);
  color: #0b0d12;
  border-bottom-left-radius: 4px;
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
/* Sticky, not just inline — a real, live-found bug this fixes: as a
   conversation grows and stays expanded, autoscroll-to-newest keeps
   pinning the view to the BOTTOM, pushing this toggle (the first child of
   .cairn-stack, at the top) further and further out of reach — reachable
   only by manually scrolling all the way back up, which reads as "there
   is no collapse" even though the control was always technically there.
   Sticking it to the scroll container's own top edge (.cairn-panel is the
   nearest scrolling ancestor) keeps it clickable at every scroll
   position, the same "MessageScroller" pattern (an always-reachable
   control anchored to the scroll container, not the content) modern chat
   UI kits converged on — researched before building, not guessed. An
   opaque background + a hairline bottom border read as a small pinned
   bar once bubbles scroll underneath it, instead of stacked bubble text
   visibly passing through transparent button text. */
.cairn-history-toggle {
  position: sticky;
  top: 0;
  z-index: 1;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  border-bottom: 1px solid rgba(11, 13, 18, 0.06);
  background: rgba(255, 255, 255, 0.96);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  padding: 3px 10px;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  color: rgba(11, 13, 18, 0.55);
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
  width: var(--cairn-btn, 36px);
  height: var(--cairn-btn, 36px);
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
  width: var(--cairn-btn, 36px);
  height: var(--cairn-btn, 36px);
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

/* Movie caption — deliberately no background box (see the color-adaptation
   comment on sampleAncestorBackgroundColor). Fixed to the viewport, not the
   panel, so it reads during a call whether or not the chat panel itself is
   open; the text-shadow halo is the same real technique broadcast captions
   use for legibility over footage no single flat color guess could ever
   match — a deliberate second line of defense alongside the adaptive color,
   not a decoration. Capped width + centered so a long sentence wraps into
   a real caption block instead of stretching edge-to-edge like a banner. */
.cairn-movie-caption {
  position: fixed;
  left: 50%;
  bottom: max(28px, env(safe-area-inset-bottom, 0px) + 16px);
  transform: translateX(-50%);
  z-index: 2147483000;
  max-width: min(86vw, 620px);
  pointer-events: none;
  display: flex;
  justify-content: center;
}
/* The keyed, per-line element (see the render site's own comment) — a
   light frosted-glass pill, not a solid box: real subtitles read best
   floating just barely separated from the scene behind them, not boxed
   off from it. Kept deliberately small (see font-size below, a real, live
   request to keep this from ever reading as a banner) and re-mounts fresh
   on every new line, which is what makes the slide-up actually repeat
   per turn rather than only the first line a call ever shows. */
.cairn-movie-caption-pill {
  max-width: 100%;
  padding: 7px 18px;
  border-radius: 999px;
  background: rgba(10, 11, 15, 0.32);
  backdrop-filter: blur(7px);
  -webkit-backdrop-filter: blur(7px);
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.55), 0 0 18px rgba(0, 0, 0, 0.35);
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 8px;
  animation: cairn-caption-rise 0.32s cubic-bezier(0.16, 1, 0.3, 1);
}
.cairn-movie-caption-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  border: 1.5px solid currentColor;
  opacity: 0.75;
  align-self: center;
}
.cairn-movie-caption-dot-agent {
  background: currentColor;
}
@keyframes cairn-caption-rise {
  from {
    opacity: 0;
    transform: translateY(18px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (max-width: 480px) {
  .cairn-movie-caption {
    max-width: 92vw;
    bottom: max(20px, env(safe-area-inset-bottom, 0px) + 12px);
  }
  .cairn-movie-caption-pill {
    font-size: 13.5px;
    padding: 6px 14px;
  }
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

/* A second, smaller launcher beside the main FAB (the "logo" button) — same
   row, not stacked above it — instead of a row inside the panel: the
   panel's own vertical space stays 100% conversation, and this reads as a
   normal secondary control the way a video call's "settings" cog sits
   beside, not inside, the call window. Same bottom offset as the main FAB
   (20px), pushed inward by the FAB's own width plus a 10px gap
   (52 + 10 = 62px) so the two sit side by side. */
.cairn-settings-fab {
  position: fixed;
  right: 82px;
  bottom: 20px;
  z-index: 2147483000;
  width: 30px;
  height: 30px;
  border-radius: 999px;
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.96);
  color: #33384a;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.16);
  -webkit-backdrop-filter: blur(12px);
  backdrop-filter: blur(12px);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.cairn-settings-fab:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.2);
}
.cairn-settings-fab.cairn-pos-left {
  right: auto;
  left: 82px;
}

.cairn-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.cairn-settings-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cairn-settings-heading {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: rgba(11, 13, 18, 0.4);
}
.cairn-settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.cairn-settings-label {
  font-size: var(--cairn-font, 13.5px);
  color: #0b0d12;
}
.cairn-segmented {
  display: inline-flex;
  padding: 2px;
  border-radius: 999px;
  background: rgba(11, 13, 18, 0.06);
}
.cairn-segmented-btn {
  border: none;
  background: transparent;
  color: rgba(11, 13, 18, 0.55);
  font: inherit;
  font-size: 11.5px;
  font-weight: 600;
  padding: 5px 10px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.cairn-segmented-btn-active {
  background: #14151b;
  color: white;
}
.cairn-toggle {
  flex-shrink: 0;
  width: 34px;
  height: 20px;
  padding: 2px;
  border: none;
  border-radius: 999px;
  background: rgba(11, 13, 18, 0.16);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  transition: background 0.15s ease;
}
.cairn-toggle-on {
  background: #14151b;
  justify-content: flex-end;
}
.cairn-toggle-knob {
  width: 16px;
  height: 16px;
  border-radius: 999px;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.cairn-clear-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  border: none;
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 7px 12px;
  border-radius: 999px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.cairn-clear-btn:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.18);
}
.cairn-clear-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
`;

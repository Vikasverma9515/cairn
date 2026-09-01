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
import type { HistoryTurn as HistoryEntry, TourStep } from "@cairnvibe/core";
import { collectVisible } from "./context-collector";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";
import { createLiveElementRegistry } from "./runtime-scan";
import { executeVerbResponse } from "./verb-executor";

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
    sendFreshContext(); // no-op if no realtime session is open
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
  const activeAudioRef = useRef<HTMLAudioElement | null>(null);
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
  function sendFreshContext() {
    const ws = rtSocketRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const liveScan = liveRegistryRef.current.getSnapshot();
    liveMapRef.current = liveScan.byId;
    ws.send(
      JSON.stringify({ type: "context", route: pathnameRef.current, visible: collectVisible(), liveElements: liveScan.elements }),
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
    executeVerbResponse(raw, pathname, {
      onExplain: (text) => {
        setAnswer(text);
        if (!realtimeActive) void speak(text); // realtime mode gets audio over the socket instead
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
    const wasRealtimeListening = realtimeActive;
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
      if (wasRealtimeListening && realtimeActive) setRtStatus("rt-listening");
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
      const liveScan = liveRegistryRef.current.getSnapshot();
      liveMapRef.current = liveScan.byId;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          route: pathname,
          question: q,
          visible: collectVisible(),
          history: historyRef.current,
          liveElements: liveScan.elements,
        }),
      });
      const data = await res.json().catch(() => null);
      handleVerb(data);
      // Unlike the realtime relay (one persistent connection, memory lives
      // server-side), each of these POSTs is stateless — the widget itself
      // is what remembers, and resends it above so the model has context
      // for "the first one" / "do that instead" on the next question.
      historyRef.current = [
        ...historyRef.current,
        { role: "user", text: q } satisfies HistoryEntry,
        { role: "assistant", text: summarizeVerbForHistory(data) } satisfies HistoryEntry,
      ].slice(-MAX_HISTORY_TURNS);
    } catch {
      setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      setStatus("idle");
    }
  }

  /**
   * The one place that starts audio playback for a spoken response — stops
   * whatever's currently playing first, so two responses (e.g. a rapid
   * double-click on "start conversation", or two utterances resolved close
   * together) can never be heard overlapping. Used by both the typed/mic
   * path and the realtime path.
   */
  function playResponseAudio(blob: Blob): Promise<void> {
    if (activeAudioRef.current) {
      activeAudioRef.current.pause();
      activeAudioRef.current.currentTime = 0;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    activeAudioRef.current = audio;
    return new Promise((resolve) => {
      const clear = () => {
        URL.revokeObjectURL(url);
        if (activeAudioRef.current === audio) activeAudioRef.current = null;
        resolve();
      };
      audio.onended = clear;
      audio.play().catch(clear);
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
      if (!res.ok) return;
      void playResponseAudio(await res.blob());
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
      if (!res.ok) return;
      await playResponseAudio(await res.blob());
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
        if (!settled) console.warn("[cairn] tour step audio confirmation timed out — continuing");
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
    rtStartingRef.current = true;
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

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (rtMicMutedRef.current) return;

        // Barge-in: while the agent is speaking a real conversational reply,
        // still thinking about one, OR mid-tour, keep listening to the mic
        // locally even though it isn't being sent yet, and cut the agent
        // off the instant the user starts talking again instead of making
        // them wait — including during a guided tour, which now cancels the
        // rest of the walkthrough on interruption (see triggerBargeIn)
        // instead of being talked-over-proof by design, the way a real
        // person giving a tour stops when you have a question. The
        // "rt-thinking" half matters just as much as "rt-speaking": an LLM
        // turn can easily take a couple of seconds with nothing playing
        // yet, and without this the mic was completely deaf during that
        // whole window — found live as "not listening while speaking... no
        // interrupting system", not just a missed nice-to-have.
        if (rtStateRef.current === "rt-speaking" || rtStateRef.current === "rt-thinking") {
          const rms = computeRms(e.inputBuffer.getChannelData(0));
          if (rms > BARGE_IN_RMS_THRESHOLD) triggerBargeIn();
          return;
        }

        if (rtStateRef.current !== "rt-listening") return; // don't send our own mic while the agent is thinking/speaking
        const pcm = floatTo16BitPCM(downsampleTo16k(e.inputBuffer.getChannelData(0), audioCtx.sampleRate));
        ws.send(pcm);
      };
      source.connect(processor);
      processor.connect(silence);
      silence.connect(audioCtx.destination);

      rtCleanupRef.current = () => {
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
        setRtStatus("rt-listening");
        setCaption("");
        sendFreshContext(); // refresh before the user starts talking again, not after
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
          console.warn("[cairn] realtime turn timed out waiting on the server — resuming listening");
          rtAudioDoneArrivingRef.current = true;
          setRtStatus("rt-listening");
          setCaption("");
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
        setCaption("");
      }

      ws.onopen = () => {
        sendFreshContext();
        setRtStatus("rt-listening");
        rtStartingRef.current = false;
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return; // audio now arrives as base64 inside audio_chunk, not raw binary frames
        const msg = JSON.parse(event.data);
        if (msg.type === "interim") {
          setCaption(msg.text);
        } else if (msg.type === "final") {
          archiveCurrentExchange(); // the previous turn's pair is complete — move it into history before this one starts overwriting caption/answer
          setCaption(msg.text);
          setRtStatus("rt-thinking");
          armThinkingWatchdog();
        } else if (msg.type === "verb") {
          disarmThinkingWatchdog();
          handleVerb(msg.verb);
        } else if (msg.type === "speaking_start") {
          disarmThinkingWatchdog();
          rtAudioDoneArrivingRef.current = false;
          setRtStatus("rt-speaking");
        } else if (msg.type === "audio_chunk") {
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
          // turn_complete covers a verb with nothing spoken (a plain
          // highlight/navigate/do often has no text) — no audio_chunk ever
          // arrives for it, so rtScheduledSourcesRef is already empty and
          // maybeResumeListening() resumes immediately below.
          disarmThinkingWatchdog();
          rtAudioDoneArrivingRef.current = true;
          maybeResumeListening();
        } else if (msg.type === "error") {
          // Must actually unstick the turn, not just show the message —
          // otherwise the mic never resumes and the session is stuck
          // exactly the way a silently-dropped response used to leave it.
          disarmThinkingWatchdog();
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
        setAnswer("Couldn't connect to the realtime voice service.");
        endRealtime();
      };
      ws.onclose = () => {
        if (rtStateRef.current !== "idle") endRealtime();
      };
    } catch {
      setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
      setRtStatus("idle");
      rtStartingRef.current = false;
    }
  }

  function endRealtime() {
    if (rtThinkingWatchdogRef.current) {
      clearTimeout(rtThinkingWatchdogRef.current);
      rtThinkingWatchdogRef.current = null;
    }
    rtStartingRef.current = false;
    activeAudioRef.current?.pause();
    activeAudioRef.current = null;
    rtSocketRef.current?.close();
    rtSocketRef.current = null;
    rtCleanupRef.current?.();
    rtCleanupRef.current = null;
    setRtMicMuted(false);
    setRtSpeakerMuted(false);
    setCaption("");
    setRtStatus("idle");
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
                    <span className="cairn-bubble-text">{renderCaptionWords(answer)}</span>
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

// ---------------------------------------------------------------------------
// Audio helpers (real-time PCM16 capture — standard Web Audio API patterns)
// ---------------------------------------------------------------------------

// Heuristic energy gate for barge-in: real speech into a laptop/phone mic
// typically sits well above this; normal room noise and the mic's own
// noise floor typically sit below it. Not calibrated against real hardware
// in this environment (no live mic here) — reasonable starting point, may
// need tuning against a real device if it proves too trigger-happy or too
// insensitive in practice.
const BARGE_IN_RMS_THRESHOLD = 0.02;

function computeRms(channelData: Float32Array): number {
  let sumSquares = 0;
  for (let i = 0; i < channelData.length; i++) sumSquares += channelData[i] * channelData[i];
  return Math.sqrt(sumSquares / channelData.length);
}

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

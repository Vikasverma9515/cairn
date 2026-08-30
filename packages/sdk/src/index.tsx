"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
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
import type { TourStep } from "@cairn/core";
import { collectVisible } from "./context-collector";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";
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
  /** If set, the widget speaks each explain/highlight answer aloud (Deepgram TTS via `@cairn/sdk/speak-server`). */
  speakEndpoint?: string;
  /**
   * If set, shows a "start conversation" control that opens a live
   * WebSocket to a `@cairn/sdk/realtime-server` relay (run via
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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [caption, setCaption] = useState("");
  const [rtMicMuted, setRtMicMuted] = useState(false);
  const [rtSpeakerMuted, setRtSpeakerMuted] = useState(false);
  // Set while a "tour" verb's steps are being narrated/highlighted one at a
  // time — drives the step-progress caption and blocks the input/mic so a
  // typed or spoken question can't interrupt mid-walkthrough.
  const [tourStep, setTourStep] = useState<{ index: number; total: number } | null>(null);
  const tourGenerationRef = useRef(0); // bumped to cancel an in-progress tour (e.g. widget closed) without extra flags

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

  function setRtStatus(next: Status) {
    rtStateRef.current = next;
    setStatus(next);
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
    });
  }

  /**
   * Walks a "tour" verb's steps one at a time: highlight this step's
   * target (if any), speak/show its text, wait for that to finish, then
   * move on — this is what makes a multi-part answer feel like someone
   * actually showing you around instead of one paragraph naming several
   * buttons at once with nothing highlighted.
   *
   * Always narrates via speakEndpoint (plain request/response TTS), even
   * during a live realtime session — a tour is a distinct guided
   * walkthrough, not a conversational turn, so it doesn't need the
   * streaming relay's turn-taking machinery. If the widget is mid
   * realtime call, the mic is held off (mirrors "rt-speaking") for the
   * tour's duration so it can't pick up the tour's own narration.
   */
  async function runTour(steps: TourStep[]) {
    const myGeneration = ++tourGenerationRef.current;
    const wasRealtimeListening = realtimeActive;
    if (wasRealtimeListening) setRtStatus("rt-speaking");
    setAnswer(null);

    for (let i = 0; i < steps.length; i++) {
      if (tourGenerationRef.current !== myGeneration) return; // superseded — e.g. widget closed or a new question came in
      const step = steps[i];
      setTourStep({ index: i, total: steps.length });
      setCaption(`Step ${i + 1} of ${steps.length}`);
      setAnswer(step.text);

      if (step.target) {
        const el = findElement(step.target);
        if (el) highlightElement(el);
        else reportMiss({ attempted: step.target, route: pathname });
      }

      if (speakEndpoint) {
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
  }

  // ---------------------------------------------------------------------
  // Typed / push-to-talk question flow
  // ---------------------------------------------------------------------

  async function ask(q: string) {
    setStatus("asking");
    setAnswer(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: pathname, question: q, visible: collectVisible() }),
      });
      const data = await res.json().catch(() => null);
      handleVerb(data);
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
      function maybeResumeListening() {
        if (!rtAudioDoneArrivingRef.current) return;
        if (rtScheduledSourcesRef.current.length > 0) return;
        setRtStatus("rt-listening");
        setCaption("");
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

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "context", route: pathname, visible: collectVisible() }));
        setRtStatus("rt-listening");
        rtStartingRef.current = false;
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return; // audio now arrives as base64 inside audio_chunk, not raw binary frames
        const msg = JSON.parse(event.data);
        if (msg.type === "interim") {
          setCaption(msg.text);
        } else if (msg.type === "final") {
          setCaption(msg.text);
          setRtStatus("rt-thinking");
        } else if (msg.type === "verb") {
          handleVerb(msg.verb);
        } else if (msg.type === "speaking_start") {
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
          rtAudioDoneArrivingRef.current = true;
          maybeResumeListening();
        } else if (msg.type === "error") {
          setAnswer(msg.message ?? "Something went wrong.");
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
    setTourStep(null);
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
        <div className="cairn-panel" role="dialog" aria-label={`${persona} help panel`}>
          <div className="cairn-panel-title">{persona}</div>
          {(caption || (realtimeActive && statusLabel[status])) && (
            <div className="cairn-caption">
              {realtimeActive && <span className="cairn-caption-status">{statusLabel[status]}</span>}
              {caption && <span>{caption}</span>}
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

          {!busy && answer && <div className="cairn-answer">{answer}</div>}
        </div>
      )}
    </>
  );
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
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
}
@keyframes cairn-pulse-green {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
}
@keyframes cairn-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes cairn-rt-dot {
  0%, 100% { opacity: 0.5; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}
.cairn-glow {
  animation: cairn-pulse 1.1s ease-out 2;
  outline: 2px solid #6366f1;
  outline-offset: 3px;
  border-radius: 8px;
}
.cairn-spin {
  animation: cairn-spin 0.8s linear infinite;
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
  background: linear-gradient(155deg, #1f2430 0%, #0b0d12 100%);
  color: white;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.06) inset;
  transition: transform 0.15s ease;
}
.cairn-fab:hover {
  transform: translateY(-1px);
}
.cairn-fab-speaking {
  box-shadow: 0 8px 24px rgba(34, 197, 94, 0.35), 0 0 0 1px rgba(255, 255, 255, 0.06) inset,
    0 0 0 4px rgba(34, 197, 94, 0.22);
  animation: cairn-pulse 1.2s ease-out infinite;
}
.cairn-panel-title {
  font-weight: 700;
  font-size: 12.5px;
  letter-spacing: 0.01em;
  color: #0b0d12;
  margin-bottom: 8px;
}
.cairn-panel {
  position: fixed;
  right: 20px;
  bottom: 84px;
  z-index: 2147483000;
  width: 320px;
  max-height: 440px;
  overflow-y: auto;
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  backdrop-filter: blur(20px) saturate(160%);
  color: #0b0d12;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 20px 60px rgba(15, 15, 25, 0.22), 0 0 0 1px rgba(15, 15, 25, 0.04);
  padding: 14px;
  font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
}
.cairn-input-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.cairn-input-row input {
  flex: 1;
  box-sizing: border-box;
  padding: 9px 12px;
  border: 1px solid rgba(11, 13, 18, 0.12);
  border-radius: 10px;
  font: inherit;
  background: rgba(255, 255, 255, 0.6);
  color: #0b0d12;
}
.cairn-input-row input:disabled {
  opacity: 0.55;
}
.cairn-input-row input:focus {
  outline: none;
  border-color: rgba(99, 102, 241, 0.55);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}
.cairn-icon-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  border: 1px solid rgba(11, 13, 18, 0.12);
  background: rgba(255, 255, 255, 0.55);
  color: #33384a;
  cursor: pointer;
}
.cairn-icon-btn:hover {
  background: rgba(255, 255, 255, 0.85);
}
.cairn-icon-btn-recording {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #b91c1c;
  animation: cairn-pulse 1.4s ease-out infinite;
}
.cairn-icon-btn-speaking {
  background: #dcfce7;
  border-color: #86efac;
  color: #15803d;
  animation: cairn-pulse-green 1.2s ease-out infinite;
}
.cairn-icon-btn-end {
  background: #fee2e2;
  border-color: #fca5a5;
  color: #b91c1c;
}
.cairn-send {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  border: none;
  background: linear-gradient(155deg, #4f5bd5, #6366f1);
  color: white;
  cursor: pointer;
}
.cairn-send:disabled {
  background: rgba(11, 13, 18, 0.15);
  color: rgba(11, 13, 18, 0.4);
  cursor: not-allowed;
}
.cairn-caption {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.08);
  color: #33384a;
  font-size: 12.5px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.cairn-caption-status {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: #6366f1;
}
.cairn-rt-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 4px;
}
.cairn-rt-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #6366f1;
  animation: cairn-rt-dot 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.cairn-rt-dot-rt-speaking {
  background: #22c55e;
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
.cairn-answer {
  margin-top: 4px;
  padding-top: 10px;
  border-top: 1px solid rgba(11, 13, 18, 0.08);
  white-space: pre-wrap;
  color: #0b0d12;
}
`;

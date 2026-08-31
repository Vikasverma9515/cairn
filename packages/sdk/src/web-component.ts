// Framework-agnostic delivery for the Cairn widget — a plain Web Component
// (Custom Element + Shadow DOM), usable via a single <script> tag on any
// page: Vue, Angular, Svelte, a static HTML file, or Next.js/React (which
// also gets the <Copilot/> wrapper in index.tsx, for convenience).
//
// Reuses the exact same framework-neutral engine the React widget does —
// executeVerbResponse, findElement/highlightElement, collectVisible — none
// of that changes here. What's different is *rendering*: real DOM nodes
// created once and mutated in place, not JSX re-rendered on every state
// change (a naive innerHTML-per-update approach would drop input focus on
// every keystroke — see ROADMAP.md for why this matters), and *state*:
// plain instance fields instead of React state/refs. One genuine
// simplification vanilla gets for free — no ref-vs-state split needed for
// "read the current value inside an async callback without a stale
// closure" the way React's rtStateRef/rtMicMutedRef/etc. existed purely to
// solve; a class field read inside any closure on `this` is always current.
//
// Full feature parity with <Copilot/> (index.tsx), including live realtime
// voice conversation (streaming TTS, barge-in) — ported directly from that
// file's implementation, same protocol, same audio pipeline, same
// barge-in heuristic. See ROADMAP.md Phase 1 for how this was staged (a
// typed-Q&A-only MVP shipped first, live-verified, before this).

import type { HistoryTurn as HistoryEntry, TourStep } from "@cairn/core";
import { collectVisible } from "./context-collector";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";
import { executeVerbResponse } from "./verb-executor";

type Status = "idle" | "asking" | "recording" | "rt-connecting" | "rt-listening" | "rt-thinking" | "rt-speaking";

const STATUS_LABEL: Record<Status, string> = {
  idle: "",
  asking: "Thinking…",
  recording: "Listening — transcribing live…",
  "rt-connecting": "Connecting…",
  "rt-listening": "Listening…",
  "rt-thinking": "Thinking…",
  "rt-speaking": "Speaking…",
};

const MAX_HISTORY_TURNS = 8; // 4 exchanges — matches the realtime relay's own server-side cap

const STYLES = `
:host {
  all: initial;
  font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #0b0d12;
}
* { box-sizing: border-box; }
@keyframes cairn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
}
@keyframes cairn-pulse-green {
  0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(34, 197, 94, 0); }
}
@keyframes cairn-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
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
.cairn-spin { animation: cairn-spin 0.8s linear infinite; }
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
.cairn-fab:hover { transform: translateY(-1px); }
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
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  color: #0b0d12;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 20px 60px rgba(15, 15, 25, 0.22), 0 0 0 1px rgba(15, 15, 25, 0.04);
  padding: 14px;
  display: none;
}
.cairn-panel.cairn-open { display: block; }
.cairn-caption {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.08);
  color: #33384a;
  font-size: 12.5px;
  display: none;
  flex-direction: column;
  gap: 3px;
}
.cairn-caption.cairn-show { display: flex; }
.cairn-caption-status {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: #6366f1;
}
.cairn-input-row { display: flex; gap: 6px; align-items: center; }
.cairn-input-row input {
  flex: 1;
  min-width: 0;
  border: 1px solid rgba(11, 13, 18, 0.14);
  border-radius: 9px;
  padding: 8px 10px;
  font: inherit;
  background: rgba(255, 255, 255, 0.7);
  color: #0b0d12;
}
.cairn-input-row input:disabled { opacity: 0.6; }
.cairn-input-row input:focus {
  outline: none;
  border-color: rgba(99, 102, 241, 0.55);
  box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.15);
}
.cairn-icon-btn, .cairn-send {
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
.cairn-icon-btn:hover { background: rgba(255, 255, 255, 0.85); }
.cairn-send {
  border: none;
  background: linear-gradient(155deg, #4f5bd5, #6366f1);
  color: white;
}
.cairn-send:disabled, .cairn-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
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
.cairn-icon-btn-end { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }
.cairn-answer { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(11, 13, 18, 0.08); white-space: pre-wrap; }
.cairn-rt-bar { display: flex; align-items: center; gap: 8px; padding: 6px 4px; }
.cairn-rt-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #6366f1;
  animation: cairn-rt-dot 1.2s ease-in-out infinite;
  flex-shrink: 0;
}
.cairn-rt-dot-rt-speaking { background: #22c55e; }
.cairn-rt-dot-rt-thinking { background: #f59e0b; }
.cairn-rt-label { flex: 1; font-size: 12.5px; color: #33384a; }
.cairn-rt-controls { display: flex; gap: 6px; }
`;

const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`;
const MIC_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" x2="12" y1="18" y2="22"/></svg>`;
const MIC_OFF_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" y1="2" x2="22" y2="22"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/></svg>`;
const SQUARE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>`;
const SPINNER_ICON = `<svg class="cairn-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
const CLOSE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const MARK_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="12.5" width="6" height="2.6" rx="0.5" fill="currentColor"/><rect x="4.5" y="8.5" width="11" height="2.6" rx="0.5" fill="currentColor" opacity="0.75"/><rect x="8.2" y="4.5" width="3.6" height="2.6" rx="0.5" fill="currentColor" opacity="0.5"/></svg>`;
const PHONE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233 14 14 0 0 0 6.392 6.384"/></svg>`;
const PHONE_OFF_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.83 16.57a1 1 0 0 0 1.21-.3l.36-.47A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A17.87 17.87 0 0 1 9.3 17.6"/><path d="M4.27 5.34C3.5 6.44 4 8 4 8a17.9 17.9 0 0 0 2.14 6.6"/><path d="M2 2v0"/><line x1="2" y1="2" x2="22" y2="22"/></svg>`;
const VOLUME_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
const VOLUME_OFF_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;

/**
 * `<cairn-widget endpoint="/api/copilot" persona="Cairn" realtime-url="ws://..." ...>`
 * — see README.md's "Voice & conversation" / install sections for the full
 * attribute list and framework-specific examples.
 */
export class CairnWidgetElement extends HTMLElement {
  private shadow!: ShadowRoot;
  private fab!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private captionEl!: HTMLDivElement;
  private captionStatusEl!: HTMLSpanElement;
  private captionTextEl!: HTMLSpanElement;
  private formEl!: HTMLFormElement;
  private inputEl!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private micBtn: HTMLButtonElement | null = null;
  private phoneBtn: HTMLButtonElement | null = null;
  private answerEl!: HTMLDivElement;
  private rtBar!: HTMLDivElement;
  private rtDot!: HTMLSpanElement;
  private rtLabel!: HTMLSpanElement;
  private rtMicBtn!: HTMLButtonElement;
  private rtSpeakerBtn!: HTMLButtonElement;
  private rtEndBtn!: HTMLButtonElement;

  private isOpen = false;
  private status: Status = "idle";
  private recording = false;
  private touringActive = false;
  private caption = "";
  private tourGeneration = 0;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private transcribeInFlight = false;
  private activeAudio: HTMLAudioElement | null = null;
  /** Conversation memory for the typed/mic path — the realtime path keeps its own history server-side (that connection is already stateful). */
  private history: HistoryEntry[] = [];

  // --- realtime voice state ------------------------------------------------
  private rtSocket: WebSocket | null = null;
  private rtCleanup: (() => void) | null = null;
  private rtMicMuted = false;
  private rtSpeakerMuted = false;
  private rtStarting = false; // closes the click-to-first-state-update gap so a rapid double-click can't open two sessions
  private rtPlaybackCtx: AudioContext | null = null;
  private rtPlaybackGain: GainNode | null = null;
  private rtNextPlayTime = 0;
  private rtScheduledSources: AudioBufferSourceNode[] = [];
  /** True once the server says no more audio_chunks are coming for the current turn — listening only resumes once this AND every scheduled chunk has actually finished playing. */
  private rtAudioDoneArriving = true;
  /** Resolver for "this tour step's audio has fully finished playing" when narrating over an already-open realtime session. */
  private rtTourAudioDoneResolve: (() => void) | null = null;

  static get observedAttributes() {
    return ["persona"];
  }

  connectedCallback() {
    if (this.shadow) return; // already connected once — don't rebuild on re-attach
    this.shadow = this.attachShadow({ mode: "open" });
    this.buildDom();
  }

  attributeChangedCallback(name: string) {
    if (name === "persona" && this.titleEl) this.titleEl.textContent = this.persona;
  }

  // --- attributes -----------------------------------------------------
  private get endpoint(): string { return this.getAttribute("endpoint") ?? "/api/copilot"; }
  private get speakEndpoint(): string | null { return this.getAttribute("speak-endpoint"); }
  private get transcribeEndpoint(): string | null { return this.getAttribute("transcribe-endpoint"); }
  private get reportMissesEndpoint(): string | null { return this.getAttribute("report-misses-endpoint"); }
  private get realtimeUrl(): string | null { return this.getAttribute("realtime-url"); }
  private get persona(): string { return this.getAttribute("persona") ?? "Cairn"; }
  private get registeredActions(): string[] {
    return (this.getAttribute("registered-actions") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  }

  private get realtimeActive(): boolean {
    return this.status.startsWith("rt-");
  }

  private get busy(): boolean {
    return this.status === "asking" || this.status === "rt-thinking" || this.touringActive;
  }

  private micSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  // --- DOM construction (once) -----------------------------------------
  private buildDom() {
    const style = document.createElement("style");
    style.textContent = STYLES;
    this.shadow.appendChild(style);

    this.fab = document.createElement("button");
    this.fab.className = "cairn-fab";
    this.fab.innerHTML = MARK_ICON;
    this.fab.setAttribute("aria-label", `Open ${this.persona} help`);
    this.fab.addEventListener("click", () => this.toggleOpen());
    this.shadow.appendChild(this.fab);

    this.panel = document.createElement("div");
    this.panel.className = "cairn-panel";
    this.panel.setAttribute("role", "dialog");

    this.titleEl = document.createElement("div");
    this.titleEl.className = "cairn-panel-title";
    this.titleEl.textContent = this.persona;
    this.panel.appendChild(this.titleEl);

    this.captionEl = document.createElement("div");
    this.captionEl.className = "cairn-caption";
    this.captionStatusEl = document.createElement("span");
    this.captionStatusEl.className = "cairn-caption-status";
    this.captionTextEl = document.createElement("span");
    this.captionEl.appendChild(this.captionStatusEl);
    this.captionEl.appendChild(this.captionTextEl);
    this.panel.appendChild(this.captionEl);

    // --- realtime control bar (shown instead of the form while a live call is active) ---
    this.rtBar = document.createElement("div");
    this.rtBar.className = "cairn-rt-bar";
    this.rtBar.style.display = "none";

    this.rtDot = document.createElement("span");
    this.rtDot.className = "cairn-rt-dot";
    this.rtBar.appendChild(this.rtDot);

    this.rtLabel = document.createElement("span");
    this.rtLabel.className = "cairn-rt-label";
    this.rtBar.appendChild(this.rtLabel);

    const rtControls = document.createElement("div");
    rtControls.className = "cairn-rt-controls";

    this.rtMicBtn = document.createElement("button");
    this.rtMicBtn.type = "button";
    this.rtMicBtn.className = "cairn-icon-btn";
    this.rtMicBtn.innerHTML = MIC_ICON;
    this.rtMicBtn.setAttribute("aria-label", "Mute microphone");
    this.rtMicBtn.addEventListener("click", () => this.toggleRtMic());
    rtControls.appendChild(this.rtMicBtn);

    this.rtSpeakerBtn = document.createElement("button");
    this.rtSpeakerBtn.type = "button";
    this.rtSpeakerBtn.className = "cairn-icon-btn";
    this.rtSpeakerBtn.innerHTML = VOLUME_ICON;
    this.rtSpeakerBtn.setAttribute("aria-label", "Mute speaker");
    this.rtSpeakerBtn.addEventListener("click", () => this.toggleRtSpeaker());
    rtControls.appendChild(this.rtSpeakerBtn);

    this.rtEndBtn = document.createElement("button");
    this.rtEndBtn.type = "button";
    this.rtEndBtn.className = "cairn-icon-btn cairn-icon-btn-end";
    this.rtEndBtn.innerHTML = PHONE_OFF_ICON;
    this.rtEndBtn.setAttribute("aria-label", "End conversation");
    this.rtEndBtn.addEventListener("click", () => this.endRealtime());
    rtControls.appendChild(this.rtEndBtn);

    this.rtBar.appendChild(rtControls);
    this.panel.appendChild(this.rtBar);

    // --- typed question form ---
    this.formEl = document.createElement("form");
    const row = document.createElement("div");
    row.className = "cairn-input-row";

    this.inputEl = document.createElement("input");
    this.inputEl.placeholder = "What do you need help with?";
    this.inputEl.setAttribute("aria-label", `Ask ${this.persona} a question`);
    // The send button's disabled state depends on whether there's text —
    // native/uncontrolled input, so nothing re-evaluates that on its own
    // without this: typing would leave "Send" permanently disabled from
    // its initial (empty-input) state.
    this.inputEl.addEventListener("input", () => this.updateBusyState());
    row.appendChild(this.inputEl);

    if (this.realtimeUrl && this.micSupported()) {
      this.phoneBtn = document.createElement("button");
      this.phoneBtn.type = "button";
      this.phoneBtn.className = "cairn-icon-btn";
      this.phoneBtn.innerHTML = PHONE_ICON;
      this.phoneBtn.setAttribute("aria-label", "Start realtime conversation");
      this.phoneBtn.addEventListener("click", () => void this.startRealtime());
      row.appendChild(this.phoneBtn);
    }

    if (this.transcribeEndpoint && this.micSupported()) {
      this.micBtn = document.createElement("button");
      this.micBtn.type = "button";
      this.micBtn.className = "cairn-icon-btn";
      this.micBtn.innerHTML = MIC_ICON;
      this.micBtn.setAttribute("aria-label", "Ask by voice");
      this.micBtn.addEventListener("click", () => (this.recording ? this.stopRecording() : void this.startRecording()));
      row.appendChild(this.micBtn);
    }

    this.sendBtn = document.createElement("button");
    this.sendBtn.type = "submit";
    this.sendBtn.className = "cairn-send";
    this.sendBtn.innerHTML = SEND_ICON;
    this.sendBtn.setAttribute("aria-label", "Send");
    row.appendChild(this.sendBtn);

    this.formEl.appendChild(row);
    this.formEl.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = this.inputEl.value.trim();
      if (q) void this.ask(q);
    });
    this.panel.appendChild(this.formEl);

    this.answerEl = document.createElement("div");
    this.answerEl.className = "cairn-answer";
    this.panel.appendChild(this.answerEl);

    this.shadow.appendChild(this.panel);
    this.render();
  }

  // --- open/close -------------------------------------------------------
  private toggleOpen() {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle("cairn-open", this.isOpen);
    this.fab.innerHTML = this.isOpen ? CLOSE_ICON : MARK_ICON;
    this.fab.setAttribute("aria-label", this.isOpen ? `Close ${this.persona} help` : `Open ${this.persona} help`);
    if (this.isOpen && !this.realtimeActive) this.inputEl.focus();
  }

  // --- rendering ------------------------------------------------------
  /** Single place that reconciles all status-derived UI — called on every status/caption/touring change, targeted DOM mutation only (never rebuilds nodes, so focus/scroll position/etc. are never disturbed). */
  private render() {
    const realtimeActive = this.realtimeActive;

    this.fab.classList.toggle("cairn-fab-speaking", this.status === "rt-speaking");

    this.rtBar.style.display = realtimeActive ? "flex" : "none";
    this.formEl.style.display = realtimeActive ? "none" : "block";

    if (realtimeActive) {
      this.rtDot.className = `cairn-rt-dot cairn-rt-dot-${this.status}`;
      this.rtLabel.textContent = STATUS_LABEL[this.status];
      const speaking = this.status === "rt-speaking";
      this.rtMicBtn.className = speaking ? "cairn-icon-btn cairn-icon-btn-speaking" : "cairn-icon-btn";
      this.rtSpeakerBtn.className = speaking ? "cairn-icon-btn cairn-icon-btn-speaking" : "cairn-icon-btn";
      this.rtMicBtn.innerHTML = this.rtMicMuted ? MIC_OFF_ICON : MIC_ICON;
      this.rtMicBtn.setAttribute("aria-label", this.rtMicMuted ? "Unmute microphone" : "Mute microphone");
      this.rtSpeakerBtn.innerHTML = this.rtSpeakerMuted ? VOLUME_OFF_ICON : VOLUME_ICON;
      this.rtSpeakerBtn.setAttribute("aria-label", this.rtSpeakerMuted ? "Unmute speaker" : "Mute speaker");
    }

    const statusLabel = STATUS_LABEL[this.status];
    this.captionStatusEl.style.display = realtimeActive && statusLabel ? "block" : "none";
    this.captionStatusEl.textContent = statusLabel;
    this.captionTextEl.style.display = this.caption ? "block" : "none";
    this.captionTextEl.textContent = this.caption;
    this.captionEl.classList.toggle("cairn-show", !!this.caption || (realtimeActive && !!statusLabel));

    if (this.phoneBtn) this.phoneBtn.disabled = this.busy || this.recording;
    this.updateBusyState();
  }

  private setStatus(next: Status) {
    this.status = next;
    this.render();
  }

  private setCaption(text: string) {
    this.caption = text;
    this.render();
  }

  private updateBusyState() {
    this.inputEl.disabled = this.recording || this.touringActive;
    this.sendBtn.disabled = this.busy || this.recording || !this.inputEl.value.trim();
    this.sendBtn.innerHTML = this.busy ? SPINNER_ICON : SEND_ICON;
    if (this.micBtn) this.micBtn.disabled = this.touringActive;
  }

  private setAnswer(text: string | null) {
    this.answerEl.textContent = text ?? "";
  }

  private reportMiss(context: MissContext) {
    logMiss(context);
    const endpoint = this.reportMissesEndpoint;
    if (endpoint) {
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(context) }).catch(() => {});
    }
  }

  // --- ask / verb execution ------------------------------------------------
  private async ask(question: string) {
    this.setStatus("asking");
    this.setAnswer(null);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: location.pathname, question, visible: collectVisible(), history: this.history }),
      });
      const data = await res.json().catch(() => null);
      this.handleVerb(data);
      this.inputEl.value = "";
      // Unlike the realtime relay (one persistent connection, memory lives
      // server-side), each of these POSTs is stateless — the widget itself
      // is what remembers, and resends it above so the model has context
      // for "the first one" / "do that instead" on the next question.
      this.history = [
        ...this.history,
        { role: "user", text: question } satisfies HistoryEntry,
        { role: "assistant", text: summarizeVerbForHistory(data) } satisfies HistoryEntry,
      ].slice(-MAX_HISTORY_TURNS);
    } catch {
      this.setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      this.setStatus("idle");
    }
  }

  private handleVerb(raw: unknown) {
    executeVerbResponse(raw, location.pathname, {
      onExplain: (text) => {
        this.setAnswer(text);
        if (!this.realtimeActive) void this.speak(text); // realtime mode gets audio over the socket instead
      },
      onNavigate: (route) => {
        location.assign(route);
      },
      onMiss: (ctx) => this.reportMiss(ctx),
      onDo: (action, target) => {
        this.dispatchEvent(new CustomEvent("cairn-do", { detail: { action, target }, bubbles: true, composed: true }));
      },
      onTour: (steps) => void this.runTour(steps),
      registeredActions: this.registeredActions,
    });
  }

  /**
   * Walks a "tour" verb's steps one at a time: highlight this step's
   * target (if any), speak/show its text, wait for that to finish, then
   * move on. Always narrates via speakEndpoint (or the open realtime
   * socket, if there is one), even mid realtime-call — a tour is a
   * distinct guided walkthrough, not a conversational turn.
   */
  private async runTour(steps: TourStep[]) {
    const myGeneration = ++this.tourGeneration;
    const wasRealtimeListening = this.realtimeActive;
    this.touringActive = true;
    if (wasRealtimeListening) this.setStatus("rt-speaking");
    this.setAnswer(null);
    // Tracked locally rather than reading location.pathname each time — a
    // step below can navigate mid-tour, and this keeps the miss-report
    // route accurate for every step after that.
    let currentRoute = location.pathname;

    try {
      for (let i = 0; i < steps.length; i++) {
        if (this.tourGeneration !== myGeneration) return; // superseded — e.g. widget closed or a new question came in
        const step = steps[i];
        this.setCaption(`Step ${i + 1} of ${steps.length}`);
        this.setAnswer(step.text);

        if (step.route && step.route !== currentRoute) {
          // No client-side router here (framework-agnostic — there isn't
          // one to assume) — a full page navigation is the honest
          // universal fallback, and it ends this tour run since the new
          // page has no memory of it (documented limitation, see ROADMAP).
          location.assign(step.route);
          return;
        }

        if (step.target) {
          const el = findElement(step.target);
          if (el) highlightElement(el);
          else this.reportMiss({ attempted: step.target, route: currentRoute });
        }

        if (wasRealtimeListening && this.rtSocket?.readyState === WebSocket.OPEN) {
          // Already have a live streaming connection open — reuse it
          // (same Speak WS, same gapless PCM scheduling a normal reply
          // uses) instead of falling back to a separate buffered REST call.
          await this.speakOverRealtime(step.text);
        } else if (this.speakEndpoint) {
          await this.speakAndWait(step.text);
        } else {
          // No TTS configured — pace by an estimate of reading time instead of racing through every step instantly.
          await new Promise((resolve) => setTimeout(resolve, Math.max(1200, step.text.length * 45)));
        }
        if (this.tourGeneration !== myGeneration) return;
      }

      if (this.tourGeneration !== myGeneration) return;
      this.setCaption("");
      if (wasRealtimeListening && this.realtimeActive) this.setStatus("rt-listening");
    } finally {
      if (this.tourGeneration === myGeneration) {
        this.touringActive = false;
        this.render();
      }
    }
  }

  // --- speech -------------------------------------------------------------
  /** Stops whatever's currently playing first, so two responses can never be heard overlapping. Used by both the typed/mic path and tours. */
  private playResponseAudio(blob: Blob): Promise<void> {
    if (this.activeAudio) {
      this.activeAudio.pause();
      this.activeAudio.currentTime = 0;
    }
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    this.activeAudio = audio;
    return new Promise((resolve) => {
      const clear = () => {
        URL.revokeObjectURL(url);
        if (this.activeAudio === audio) this.activeAudio = null;
        resolve();
      };
      audio.onended = clear;
      audio.play().catch(clear);
    });
  }

  private async speak(text: string): Promise<void> {
    if (!this.speakEndpoint || !text.trim()) return;
    try {
      const res = await fetch(this.speakEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) return;
      void this.playResponseAudio(await res.blob());
    } catch {
      // best-effort — never let speech playback break the widget
    }
  }

  /** Like speak(), but resolves once playback actually finishes — used by runTour() so each step's highlight stays up for exactly as long as its narration takes. */
  private async speakAndWait(text: string): Promise<void> {
    if (!this.speakEndpoint || !text.trim()) return;
    try {
      const res = await fetch(this.speakEndpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
      if (!res.ok) return;
      await this.playResponseAudio(await res.blob());
    } catch {
      // best-effort — never hang the tour
    }
  }

  /** Narrates over an already-open realtime WebSocket instead of a separate REST call — resolved by maybeResumeListening() inside startRealtime() once this step's audio has both fully arrived and fully finished playing. */
  private speakOverRealtime(text: string): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.rtSocket;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve();
        return;
      }
      this.rtAudioDoneArriving = false;
      this.rtTourAudioDoneResolve = resolve;
      ws.send(JSON.stringify({ type: "speak", text }));
    });
  }

  // --- push-to-talk mic -----------------------------------------------------
  private async startRecording() {
    if (!this.transcribeEndpoint || !this.micSupported() || this.realtimeActive) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      this.audioChunks = [];
      this.setCaption("");
      recorder.ondataavailable = (e) => {
        if (e.data.size === 0) return;
        this.audioChunks.push(e.data);
        void this.transcribeSoFar(recorder.mimeType || "audio/webm", true);
      };
      recorder.onstop = () => void this.transcribeSoFar(recorder.mimeType || "audio/webm", false);
      this.mediaRecorder = recorder;
      recorder.start(2000);
      this.recording = true;
      if (this.micBtn) {
        this.micBtn.innerHTML = SQUARE_ICON;
        this.micBtn.classList.add("cairn-icon-btn-recording");
        this.micBtn.setAttribute("aria-label", "Stop recording");
      }
      this.render();
    } catch {
      this.setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
    }
  }

  private stopRecording() {
    const stream = this.mediaRecorder?.stream;
    this.mediaRecorder?.stop();
    stream?.getTracks().forEach((t) => t.stop());
    this.recording = false;
    if (this.micBtn) {
      this.micBtn.innerHTML = MIC_ICON;
      this.micBtn.classList.remove("cairn-icon-btn-recording");
      this.micBtn.setAttribute("aria-label", "Ask by voice");
    }
    this.render();
  }

  private async transcribeSoFar(mimeType: string, isProgressive: boolean) {
    if (!this.transcribeEndpoint) return;
    if (isProgressive && this.transcribeInFlight) return;
    this.transcribeInFlight = true;
    try {
      const blob = new Blob(this.audioChunks, { type: mimeType });
      const res = await fetch(this.transcribeEndpoint, { method: "POST", headers: { "content-type": mimeType }, body: blob });
      const data = await res.json().catch(() => null);
      if (data?.text) {
        this.inputEl.value = data.text;
        this.setCaption(data.text);
        this.updateBusyState();
      } else if (!isProgressive) {
        this.setAnswer("Couldn't make that out — try typing instead.");
      }
    } catch {
      if (!isProgressive) this.setAnswer("Couldn't reach the transcription service.");
    } finally {
      this.transcribeInFlight = false;
    }
  }

  // ---------------------------------------------------------------------
  // Real-time voice conversation
  // ---------------------------------------------------------------------

  private async startRealtime() {
    // rtStarting closes the gap between click and the first status update
    // landing — without it a rapid double-click could race past the
    // realtimeActive check twice and open two sessions.
    if (!this.realtimeUrl || !this.micSupported() || this.realtimeActive || this.rtStarting) return;
    this.rtStarting = true;
    this.setAnswer(null);
    this.setCaption("");
    this.setStatus("rt-connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ws = new WebSocket(this.realtimeUrl);
      ws.binaryType = "arraybuffer";
      this.rtSocket = ws;

      // Separate AudioContext from the mic capture graph below — one for
      // capture, one for playback, independently lifecycled (playback
      // keeps scheduling audio after a turn while the mic graph is
      // simultaneously idle, and vice versa).
      const playbackCtx = new AudioContext();
      const playbackGain = playbackCtx.createGain();
      playbackGain.gain.value = this.rtSpeakerMuted ? 0 : 1;
      playbackGain.connect(playbackCtx.destination);
      this.rtPlaybackCtx = playbackCtx;
      this.rtPlaybackGain = playbackGain;
      this.rtNextPlayTime = 0;
      this.rtScheduledSources = [];
      this.rtAudioDoneArriving = true;

      const audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated in favor of AudioWorklet, but
      // needs no separate worklet file to serve — fine for this scope,
      // still supported everywhere. Routed through a silent gain (not
      // straight to destination) so the mic input is never audibly looped back.
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const silence = audioCtx.createGain();
      silence.gain.value = 0;

      // Only flips back to "listening" (and lets the mic resume sending)
      // once BOTH the server has said no more audio is coming for this
      // turn AND every chunk already scheduled has actually finished
      // playing — from playback completion, not the server's speaking_end
      // alone, which is what stops the mic picking up the tail end of the
      // agent's own voice. Shared with speakOverRealtime(): while touring,
      // this same "audio fully drained" condition resolves the current
      // step's wait instead of touching status/caption.
      const maybeResumeListening = () => {
        if (!this.rtAudioDoneArriving) return;
        if (this.rtScheduledSources.length > 0) return;
        if (this.touringActive) {
          this.rtTourAudioDoneResolve?.();
          this.rtTourAudioDoneResolve = null;
          return;
        }
        this.setStatus("rt-listening");
        this.setCaption("");
      };

      const stopScheduledRtAudio = () => {
        for (const node of this.rtScheduledSources) {
          try {
            node.stop();
          } catch {
            // may have already finished naturally
          }
        }
        this.rtScheduledSources = [];
        this.rtNextPlayTime = this.rtPlaybackCtx?.currentTime ?? 0;
      };

      // Stops the agent immediately (locally) and tells the server to
      // discard whatever it's still synthesizing/sending for this turn —
      // the server tags every turn with a generation number and drops any
      // now-stale audio_chunk/speaking_end already in flight.
      const triggerBargeIn = () => {
        stopScheduledRtAudio();
        this.rtAudioDoneArriving = true;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "barge_in" }));
        this.setStatus("rt-listening");
        this.setCaption("");
      };

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (this.rtMicMuted) return;

        // Barge-in: while the agent is speaking a real conversational
        // reply (not touring — a tour deliberately can't be talked over),
        // keep listening to the mic locally even though it isn't being
        // sent yet, and cut the agent off the instant the user starts
        // talking over it instead of making them wait for it to finish.
        if (this.status === "rt-speaking" && !this.touringActive) {
          const rms = computeRms(e.inputBuffer.getChannelData(0));
          if (rms > BARGE_IN_RMS_THRESHOLD) triggerBargeIn();
          return;
        }

        if (this.status !== "rt-listening") return; // don't send our own mic while the agent is thinking/speaking
        const pcm = floatTo16BitPCM(downsampleTo16k(e.inputBuffer.getChannelData(0), audioCtx.sampleRate));
        ws.send(pcm);
      };
      source.connect(processor);
      processor.connect(silence);
      silence.connect(audioCtx.destination);

      this.rtCleanup = () => {
        processor.disconnect();
        source.disconnect();
        stream.getTracks().forEach((t) => t.stop());
        void audioCtx.close();
        stopScheduledRtAudio();
        void playbackCtx.close();
        this.rtPlaybackCtx = null;
        this.rtPlaybackGain = null;
      };

      ws.onopen = () => {
        ws.send(JSON.stringify({ type: "context", route: location.pathname, visible: collectVisible() }));
        this.setStatus("rt-listening");
        this.rtStarting = false;
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return; // audio arrives as base64 inside audio_chunk, not raw binary frames
        const msg = JSON.parse(event.data);
        if (msg.type === "interim") {
          this.setCaption(msg.text);
        } else if (msg.type === "final") {
          this.setCaption(msg.text);
          this.setStatus("rt-thinking");
        } else if (msg.type === "verb") {
          this.handleVerb(msg.verb);
        } else if (msg.type === "speaking_start") {
          this.rtAudioDoneArriving = false;
          this.setStatus("rt-speaking");
        } else if (msg.type === "audio_chunk") {
          const ctx = this.rtPlaybackCtx;
          const gain = this.rtPlaybackGain;
          if (!ctx || !gain) return;
          void ctx.resume().catch(() => {});

          // Decode base64 linear16 PCM -> Float32 samples in [-1, 1], then
          // schedule gapless-appended after whatever's already queued —
          // this is what lets playback start on the first chunk instead
          // of waiting for the whole reply.
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

          const startAt = Math.max(ctx.currentTime, this.rtNextPlayTime);
          bufferSource.start(startAt);
          this.rtNextPlayTime = startAt + buffer.duration;

          this.rtScheduledSources.push(bufferSource);
          bufferSource.onended = () => {
            this.rtScheduledSources = this.rtScheduledSources.filter((n) => n !== bufferSource);
            maybeResumeListening();
          };
        } else if (msg.type === "speaking_end" || msg.type === "turn_complete") {
          // turn_complete covers a verb with nothing spoken — no audio_chunk
          // ever arrives for it, so rtScheduledSources is already empty and
          // maybeResumeListening() resumes immediately.
          this.rtAudioDoneArriving = true;
          maybeResumeListening();
        } else if (msg.type === "error") {
          this.setAnswer(msg.message ?? "Something went wrong.");
        }
      };

      ws.onerror = () => {
        this.setAnswer("Couldn't connect to the realtime voice service.");
        this.endRealtime();
      };
      ws.onclose = () => {
        if (this.status !== "idle") this.endRealtime();
      };
    } catch {
      this.setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
      this.setStatus("idle");
      this.rtStarting = false;
    }
  }

  private endRealtime() {
    this.rtStarting = false;
    this.activeAudio?.pause();
    this.activeAudio = null;
    this.rtSocket?.close();
    this.rtSocket = null;
    this.rtCleanup?.();
    this.rtCleanup = null;
    this.rtMicMuted = false;
    this.rtSpeakerMuted = false;
    this.setCaption("");
    this.setStatus("idle");
    this.tourGeneration++; // cancel an in-progress tour rather than leaving it stuck waiting to resume rt-listening
    this.touringActive = false;
    // Unstick a tour step mid-narration over realtime — the socket above is
    // already closed, so nothing will ever deliver the audio_chunk/
    // speaking_end that would normally resolve this.
    this.rtTourAudioDoneResolve?.();
    this.rtTourAudioDoneResolve = null;
    this.render();
  }

  private toggleRtMic() {
    this.rtMicMuted = !this.rtMicMuted;
    this.render();
  }

  private toggleRtSpeaker() {
    this.rtSpeakerMuted = !this.rtSpeakerMuted;
    // Zeroing the shared gain node silences output immediately, including
    // whatever's mid-playback right now, and applies to every future
    // scheduled chunk automatically — no per-chunk check needed.
    if (this.rtPlaybackGain) this.rtPlaybackGain.gain.value = this.rtSpeakerMuted ? 0 : 1;
    this.render();
  }
}

/** Best-effort text form of a raw (unvalidated) verb response for the
 * conversation-history log — not shown to the user, just fed back to the
 * model on later turns. */
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

// ---------------------------------------------------------------------------
// Audio helpers (real-time PCM16 capture — standard Web Audio API patterns,
// identical to index.tsx's — same protocol, same math, ported directly)
// ---------------------------------------------------------------------------

// Heuristic energy gate for barge-in: real speech into a laptop/phone mic
// typically sits well above this; normal room noise and the mic's own
// noise floor typically sit below it. Same threshold as the React widget —
// not independently recalibrated, since it's the same audio pipeline.
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

if (typeof customElements !== "undefined" && !customElements.get("cairn-widget")) {
  customElements.define("cairn-widget", CairnWidgetElement);
}

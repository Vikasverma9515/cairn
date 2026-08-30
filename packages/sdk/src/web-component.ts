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
// every keystroke — see BUILD_PLAN/ROADMAP for why this matters).
//
// Scope for this first pass (see ROADMAP.md Phase 1): typed questions,
// spoken answers (speakEndpoint), push-to-talk mic (transcribeEndpoint),
// tours, explain/highlight/navigate/do. Full live realtime voice
// conversation (realtimeUrl, barge-in) stays React-only for now — that's
// the highest-complexity, highest-testing-cost piece (mic PCM streaming,
// gapless audio scheduling, barge-in) and re-verifying it in a second
// implementation wasn't a responsible thing to do blind in one pass.

import type { TourStep } from "@cairn/core";
import { collectVisible } from "./context-collector";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";
import { executeVerbResponse } from "./verb-executor";

const STYLES = `
:host {
  all: initial;
  font: 13.5px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: #0b0d12;
}
* { box-sizing: border-box; }
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
}
.cairn-fab:hover { transform: translateY(-1px); }
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
.cairn-panel-title { font-weight: 700; font-size: 12.5px; margin-bottom: 8px; }
.cairn-caption {
  margin-bottom: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: rgba(99, 102, 241, 0.08);
  color: #33384a;
  font-size: 12.5px;
  display: none;
}
.cairn-caption.cairn-show { display: block; }
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
.cairn-send {
  border: none;
  background: linear-gradient(155deg, #4f5bd5, #6366f1);
  color: white;
}
.cairn-send:disabled, .cairn-icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.cairn-icon-btn-recording { background: #fee2e2; border-color: #fca5a5; color: #b91c1c; }
.cairn-answer { margin-top: 10px; white-space: pre-wrap; }
.cairn-spin { animation: cairn-spin 0.8s linear infinite; }
@keyframes cairn-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes cairn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.45); }
  70% { box-shadow: 0 0 0 10px rgba(99, 102, 241, 0); }
}
`;

const SEND_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>`;
const MIC_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" x2="12" y1="18" y2="22"/></svg>`;
const SQUARE_ICON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="2"/></svg>`;
const SPINNER_ICON = `<svg class="cairn-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
const CLOSE_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;
const MARK_ICON = `<svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="12.5" width="6" height="2.6" rx="0.5" fill="currentColor"/><rect x="4.5" y="8.5" width="11" height="2.6" rx="0.5" fill="currentColor" opacity="0.75"/><rect x="8.2" y="4.5" width="3.6" height="2.6" rx="0.5" fill="currentColor" opacity="0.5"/></svg>`;

/**
 * `<cairn-widget endpoint="/api/copilot" persona="Cairn" ...>` — see
 * README.md's "Voice & conversation" / install sections for the full
 * attribute list and framework-specific examples.
 */
export class CairnWidgetElement extends HTMLElement {
  private shadow!: ShadowRoot;
  private fab!: HTMLButtonElement;
  private panel!: HTMLDivElement;
  private titleEl!: HTMLDivElement;
  private captionEl!: HTMLDivElement;
  private inputEl!: HTMLInputElement;
  private sendBtn!: HTMLButtonElement;
  private micBtn: HTMLButtonElement | null = null;
  private answerEl!: HTMLDivElement;

  private isOpen = false;
  private busy = false;
  private recording = false;
  private tourGeneration = 0;
  private activeAudio: HTMLAudioElement | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private transcribeInFlight = false;

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
  private get persona(): string { return this.getAttribute("persona") ?? "Cairn"; }
  private get registeredActions(): string[] {
    return (this.getAttribute("registered-actions") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
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
    this.panel.appendChild(this.captionEl);

    const form = document.createElement("form");
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

    form.appendChild(row);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const q = this.inputEl.value.trim();
      if (q) void this.ask(q);
    });
    this.panel.appendChild(form);

    this.answerEl = document.createElement("div");
    this.answerEl.className = "cairn-answer";
    this.panel.appendChild(this.answerEl);

    this.shadow.appendChild(this.panel);
    this.updateBusyState();
  }

  private micSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
  }

  // --- open/close -------------------------------------------------------
  private toggleOpen() {
    this.isOpen = !this.isOpen;
    this.panel.classList.toggle("cairn-open", this.isOpen);
    this.fab.innerHTML = this.isOpen ? CLOSE_ICON : MARK_ICON;
    this.fab.setAttribute("aria-label", this.isOpen ? `Close ${this.persona} help` : `Open ${this.persona} help`);
    if (this.isOpen) this.inputEl.focus();
  }

  // --- state helpers ------------------------------------------------------
  private setBusy(busy: boolean) {
    this.busy = busy;
    this.updateBusyState();
  }

  private updateBusyState() {
    this.inputEl.disabled = this.busy || this.recording;
    this.sendBtn.disabled = this.busy || this.recording || !this.inputEl.value.trim();
    this.sendBtn.innerHTML = this.busy ? SPINNER_ICON : SEND_ICON;
    if (this.micBtn) this.micBtn.disabled = this.busy;
  }

  private setCaption(text: string) {
    this.captionEl.textContent = text;
    this.captionEl.classList.toggle("cairn-show", !!text);
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
    this.setBusy(true);
    this.setAnswer(null);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: location.pathname, question, visible: collectVisible() }),
      });
      const data = await res.json().catch(() => null);
      this.handleVerb(data);
      this.inputEl.value = "";
    } catch {
      this.setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      this.setBusy(false);
    }
  }

  private handleVerb(raw: unknown) {
    executeVerbResponse(raw, location.pathname, {
      onExplain: (text) => {
        this.setAnswer(text);
        void this.speak(text);
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

  private async runTour(steps: TourStep[]) {
    const myGeneration = ++this.tourGeneration;
    this.setBusy(true);
    this.setAnswer(null);
    for (let i = 0; i < steps.length; i++) {
      if (this.tourGeneration !== myGeneration) return;
      const step = steps[i];
      this.setCaption(`Step ${i + 1} of ${steps.length}`);
      this.setAnswer(step.text);
      if (step.route && step.route !== location.pathname) {
        location.assign(step.route);
        return; // a full page nav ends this tour run — the new page has no memory of it (documented limitation, see ROADMAP)
      }
      if (step.target) {
        const el = findElement(step.target);
        if (el) highlightElement(el);
        else this.reportMiss({ attempted: step.target, route: location.pathname });
      }
      if (this.speakEndpoint) await this.speakAndWait(step.text);
      else await new Promise((resolve) => setTimeout(resolve, Math.max(1200, step.text.length * 45)));
      if (this.tourGeneration !== myGeneration) return;
    }
    this.setCaption("");
    this.setBusy(false);
  }

  // --- speech -------------------------------------------------------------
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
      // best-effort
    }
  }

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

  // --- push-to-talk mic -----------------------------------------------------
  private async startRecording() {
    if (!this.transcribeEndpoint || !this.micSupported()) return;
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
      this.updateBusyState();
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
    this.updateBusyState();
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
}

if (typeof customElements !== "undefined" && !customElements.get("cairn-widget")) {
  customElements.define("cairn-widget", CairnWidgetElement);
}

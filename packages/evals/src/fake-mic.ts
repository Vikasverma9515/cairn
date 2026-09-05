// Fakes the microphone at the browser API level so Cairn's REAL, unmodified
// client-side realtime code (mic capture, downsampling, PCM encoding, the
// WebSocket protocol, tool execution) runs completely as-is — the harness
// never reimplements any of that, it just answers `getUserMedia` with a
// real MediaStream playing pre-synthesized speech instead of a live mic.
// Standard browser technique: decode the audio into an AudioBuffer, route
// an AudioBufferSourceNode into a MediaStreamAudioDestinationNode, and hand
// back its `.stream` — indistinguishable from a real input device to any
// code that only consumes the MediaStream (createMediaStreamSource, as
// index.tsx's own realtime path does).
import type { Page } from "playwright";

/** Installs the fake mic before any page script runs (Playwright's
 * addInitScript re-runs this on every navigation) and grants mic
 * permission on the context, matching what a real device-permission grant
 * looks like to the page. `audioBase64` is one scenario's full synthesized
 * opening utterance (see synthesize.ts), played the instant the page's own
 * code calls getUserMedia. The SAME underlying MediaStreamDestination stays
 * live and mixable for the rest of the page's lifetime — see
 * injectMicSpeech/injectMicNoise below, added for barge-in probing, which
 * play a SECOND clip into the same real stream mid-call, exactly like a
 * real person (or a real noise) speaking into the mic while a call is
 * already in progress. */
export async function installFakeMic(page: Page, audioBase64: string): Promise<void> {
  await page.context().grantPermissions(["microphone"]);
  // Raw string content, not a passed function reference — found live:
  // addInitScript(fn, arg) serializes the closure via Playwright's own
  // esbuild-based bundling, which (for a closure with nested named
  // function declarations, like this one) emitted a `__name(...)` helper
  // call with no matching helper definition, throwing "__name is not
  // defined" the instant the init script ran — silently breaking
  // getUserMedia for every page load. A plain content string sidesteps
  // that serialization step entirely.
  await page.addInitScript({ content: buildFakeMicScript(audioBase64) });
}

/** Plays a SECOND real synthesized speech clip into the already-live fake
 * mic stream — used by the barge-in probes to simulate the user saying
 * something (e.g. "stop") WHILE the agent is mid-answer, the way a real
 * interruption actually happens: overlapping the agent's own TTS audio
 * (which plays through a separate AudioContext — see index.tsx's own
 * playback graph), not replacing the opening clip. `audioBase64` is real
 * synthesized speech from synthesize.ts, same as the opening clip. */
export async function injectMicSpeech(page: Page, audioBase64: string): Promise<void> {
  await page.evaluate((b64) => (window as unknown as { __cairnEvalInjectSpeech: (b64: string) => Promise<void> }).__cairnEvalInjectSpeech(b64), audioBase64);
}

/** Plays a burst of real broadband noise (NOT speech — procedurally
 * generated random samples, since Deepgram's TTS can only produce speech)
 * into the already-live fake mic stream — used by the barge-in probes to
 * simulate a cough/door-slam/background sound while the agent is mid-
 * answer, the real acoustic shape `vad.ts`'s zero-crossing-rate gate is
 * specifically built to reject. */
export async function injectMicNoise(page: Page, durationMs: number): Promise<void> {
  await page.evaluate(
    (ms) => (window as unknown as { __cairnEvalInjectNoise: (ms: number) => Promise<void> }).__cairnEvalInjectNoise(ms),
    durationMs,
  );
}

function buildFakeMicScript(audioBase64: string): string {
  return `(() => {
    const base64 = ${JSON.stringify(audioBase64)};

    function base64ToArrayBuffer(b64) {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    const audioBytes = base64ToArrayBuffer(base64);
    let decodedBuffer = null;
    // Lazily created on the first real getUserMedia call and then reused —
    // injectMicSpeech/injectMicNoise mix additional sources into this SAME
    // graph, exactly like a real second sound source hitting one real mic.
    let sharedCtx = null;
    let sharedDestination = null;

    async function ensureGraph() {
      if (!sharedCtx) {
        sharedCtx = new AudioContext();
        sharedDestination = sharedCtx.createMediaStreamDestination();
      }
      return { ctx: sharedCtx, destination: sharedDestination };
    }

    const realGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    async function fakeGetUserMedia(constraints) {
      if (!constraints || !constraints.audio) {
        if (realGetUserMedia) return realGetUserMedia(constraints);
        throw new Error("fake-mic: only audio-only getUserMedia calls are supported in eval runs");
      }
      const { ctx, destination } = await ensureGraph();
      if (!decodedBuffer) {
        decodedBuffer = await ctx.decodeAudioData(audioBytes.slice(0));
      }
      const source = ctx.createBufferSource();
      source.buffer = decodedBuffer;
      source.connect(destination);
      source.start();
      return destination.stream;
    }

    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: fakeGetUserMedia,
      writable: true,
      configurable: true,
    });

    // Barge-in probing hooks — called from Node via page.evaluate() at a
    // real, chosen moment (once the harness has observed a real
    // "speaking_start" WS frame), not baked into the opening clip's fixed
    // timing, since real LLM/TTS latency varies too much to predict in
    // advance.
    window.__cairnEvalInjectSpeech = async (b64) => {
      const { ctx, destination } = await ensureGraph();
      const buffer = await ctx.decodeAudioData(base64ToArrayBuffer(b64));
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
    };

    window.__cairnEvalInjectNoise = async (durationMs) => {
      const { ctx, destination } = await ensureGraph();
      const sampleRate = ctx.sampleRate;
      const length = Math.max(1, Math.round((durationMs / 1000) * sampleRate));
      const buffer = ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);
      // Real broadband noise (every sample independently random) — the
      // exact acoustic shape vad.ts's zero-crossing-rate gate rejects
      // (ZCR near its ceiling), a fair stand-in for a cough/static/hiss
      // burst without needing a real recorded sample library.
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination);
      source.start();
    };
  })();`;
}

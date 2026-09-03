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
 * utterance (see synthesize.ts) — every getUserMedia call during this
 * page's lifetime plays it back once, unmodified. */
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

    const realGetUserMedia = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

    async function fakeGetUserMedia(constraints) {
      if (!constraints || !constraints.audio) {
        if (realGetUserMedia) return realGetUserMedia(constraints);
        throw new Error("fake-mic: only audio-only getUserMedia calls are supported in eval runs");
      }
      const decodeCtx = new AudioContext();
      if (!decodedBuffer) {
        decodedBuffer = await decodeCtx.decodeAudioData(audioBytes.slice(0));
      }
      const destination = decodeCtx.createMediaStreamDestination();
      const source = decodeCtx.createBufferSource();
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
  })();`;
}

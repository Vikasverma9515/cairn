// Drives one scenario, on one transport, against a real running playground
// app in a real Playwright browser — no reimplementation of Cairn's client
// code anywhere: the typed path just types into the real widget and clicks
// Send; the voice path just clicks "Start realtime conversation" with a
// faked mic (fake-mic.ts) feeding real synthesized audio. Whatever the
// widget's own code does with either — including the whole agent loop,
// tool execution, and (voice) audio playback — runs completely unmodified.
// The harness only ever *observes*: network round trips, WebSocket frames,
// and the app's own real final state.
import { chromium, type Page } from "playwright";
import { installFakeMic } from "./fake-mic";
import type { Scenario } from "./scenario";
import { synthesizeSpeech } from "./synthesize";
import type { CopilotRoundTrip, ScenarioRunResult, VoiceFrame, VoiceLatencies } from "./trace";

export interface RunnerOptions {
  deepgramApiKey: string;
  headless?: boolean;
  /** Overall per-run ceiling, ms — a real failure (hang, infinite loop)
   * degrades the run instead of blocking the suite forever. */
  timeoutMs?: number;
  /** How long the copilot/WS channel must go quiet before a run is
   * considered finished, ms. */
  quietMs?: number;
}

// Groq calls have measured up to ~30s elsewhere this session under load —
// generous on purpose so a real (if slow) run isn't mistaken for a hang.
const DEFAULT_TIMEOUT_MS = 90_000;
// Real bug, found live: a multi-step loop's SECOND (and later) round trip
// can itself take as long as the first — a short quietMs mistakes "still
// waiting on the next Groq call" for "the whole loop is done" and cuts the
// run off after just the first step. Measured live: a real two-step
// archive flow had a ~10s gap between its "read" and "do" round trips
// under real Groq load — 15s gives real headroom above that. The hard
// timeoutMs ceiling still catches a genuine hang.
const DEFAULT_QUIET_MS = 15_000;

export async function runScenario(scenario: Scenario, transport: "typed" | "voice", options: RunnerOptions): Promise<ScenarioRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const startedAt = new Date().toISOString();
  const browser = await chromium.launch({ headless: options.headless ?? true });

  const roundTrips: CopilotRoundTrip[] = [];
  const voiceFrames: VoiceFrame[] = [];
  let lastActivityAt = Date.now();
  let voiceStartedAt: number | null = null;

  try {
    for (const step of scenario.setup ?? []) {
      await fetch(new URL(step.path, scenario.baseUrl), { method: step.method ?? "POST" });
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    page.on("requestfinished", async (request) => {
      const url = request.url();
      if (!url.includes("/api/copilot") || url.includes("/speak") || url.includes("/transcribe")) return;
      lastActivityAt = Date.now();
      let requestBody: unknown = null;
      let responseBody: unknown = null;
      try {
        requestBody = request.postDataJSON();
      } catch {
        // no JSON body on this request — fine, leave null
      }
      try {
        responseBody = await (await request.response())?.json();
      } catch {
        // non-JSON or failed response — fine, leave null
      }
      roundTrips.push({ requestBody, responseBody, requestedAt: lastActivityAt, respondedAt: Date.now() });
    });

    if (transport === "voice") {
      page.on("websocket", (ws) => {
        // Real bug, found live: the page also opens Next.js's own dev-mode
        // HMR socket — without filtering, that noise (ping/client-success/
        // sync frames every couple seconds) drowned out the one socket
        // that actually matters, and the run reported zero real voice
        // activity even though the realtime connection worked fine.
        // Excluding known framework noise (rather than matching one
        // hardcoded port) keeps this working across whatever port a given
        // playground app's realtimeUrl actually points at.
        if (ws.url().includes("webpack-hmr") || ws.url().includes("/_next/")) return;
        const record = (direction: "sent" | "received") => (frame: { payload: string | Buffer }) => {
          lastActivityAt = Date.now();
          if (typeof frame.payload !== "string") return; // raw mic/audio binary frames — not stored individually, see file doc comment
          try {
            voiceFrames.push({ direction, data: JSON.parse(frame.payload), at: Date.now() });
          } catch {
            // a non-JSON text frame — shouldn't happen per the realtime protocol, skip rather than crash the run
          }
        };
        ws.on("framesent", record("sent"));
        ws.on("framereceived", record("received"));
      });

      const audio = await synthesizeSpeech(scenario.goal, { apiKey: options.deepgramApiKey });
      await installFakeMic(page, audio.toString("base64"));
    }

    await page.goto(new URL(scenario.path, scenario.baseUrl).toString(), { waitUntil: "networkidle" });
    await openWidget(page);

    if (transport === "typed") {
      await runTypedTurn(page, scenario.goal);
    } else {
      voiceStartedAt = await runVoiceTurn(page);
    }
    // Real bug, found live: lastActivityAt starts at function entry, before
    // goto/openWidget/the turn itself — by the time this point is reached
    // (often already 1-2s later), idleFor was already past quietMs on the
    // very first waitUntilQuiet check, returning immediately and closing
    // the browser before the real async request/response ever completed.
    // Reset the clock here, right after triggering the real interaction.
    lastActivityAt = Date.now();

    // Second real bug, found live: quietMs alone can't tell "nothing has
    // happened yet" (the very first request just hasn't landed — Groq has
    // taken up to ~30s elsewhere this session) apart from "everything's
    // done" — both look like N seconds of silence. Require at least one
    // real round trip (or voice frame) before the quiet check is allowed
    // to succeed at all; the hard timeoutMs ceiling still applies either way.
    const hasSeenActivity = () => (transport === "typed" ? roundTrips.length > 0 : voiceFrames.length > 0);
    await waitUntilQuiet(() => lastActivityAt, hasSeenActivity, quietMs, timeoutMs);

    const finalState = await fetch(new URL(scenario.verify.path, scenario.baseUrl), { method: scenario.verify.method ?? "GET" })
      .then((res) => res.json())
      .catch(() => null);
    const achieved = matchesExpectation(finalState, scenario.verify.expectContains);

    const result: ScenarioRunResult = {
      scenarioId: scenario.id,
      transport,
      startedAt,
      finalState,
      achieved,
      copilotRoundTrips: roundTrips,
    };
    if (transport === "voice") {
      result.voiceFrames = voiceFrames;
      result.voiceLatencies = computeVoiceLatencies(voiceStartedAt, voiceFrames);
    }
    return result;
  } catch (err) {
    return {
      scenarioId: scenario.id,
      transport,
      startedAt,
      finalState: null,
      achieved: false,
      copilotRoundTrips: roundTrips,
      voiceFrames: transport === "voice" ? voiceFrames : undefined,
      runError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser.close();
  }
}

async function openWidget(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label="Open Cairn help"]');
  if (await toggle.count()) await toggle.click();
}

async function runTypedTurn(page: Page, goal: string): Promise<void> {
  const input = page.locator('input[placeholder="What do you need help with?"]');
  await input.fill(goal);
  const sendButton = page.locator('button[type="submit"]').last();
  await sendButton.click();
}

/** Returns the timestamp mic playback effectively starts — used as the
 * mic-to-transcript latency's zero point. */
async function runVoiceTurn(page: Page): Promise<number> {
  const startButton = page.locator('[aria-label="Start realtime conversation"]');
  await startButton.click();
  // The fake mic (fake-mic.ts) starts playing the instant the page's own
  // code calls getUserMedia, which happens as part of the click above —
  // give the connection a moment to actually open before treating "now" as
  // the zero point, otherwise the mic-to-transcript number would include
  // connection setup time that isn't part of what's being measured.
  await page.waitForTimeout(500);
  return Date.now();
}

async function waitUntilQuiet(getLastActivityAt: () => number, hasSeenActivity: () => boolean, quietMs: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const idleFor = Date.now() - getLastActivityAt();
    if (hasSeenActivity() && idleFor >= quietMs) return;
    if (Date.now() >= deadline) return; // real failure (hang/loop/nothing ever arrived) degrades the run rather than blocking the suite forever
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function matchesExpectation(finalState: unknown, expect: string | string[]): boolean {
  const haystack = JSON.stringify(finalState ?? "");
  const needles = Array.isArray(expect) ? expect : [expect];
  return needles.every((needle) => haystack.includes(needle));
}

export function computeVoiceLatencies(voiceStartedAt: number | null, frames: VoiceFrame[]): VoiceLatencies {
  const at = (predicate: (f: VoiceFrame) => boolean): number | null => frames.find(predicate)?.at ?? null;
  const isType = (type: string) => (f: VoiceFrame) => f.direction === "received" && typeof f.data === "object" && f.data !== null && (f.data as { type?: string }).type === type;

  const firstFinal = at(isType("final"));
  const firstVerb = at(isType("verb"));
  const firstAudio = at((f) => isType("audio_chunk")(f) || isType("turn_complete")(f));

  return {
    micToTranscriptMs: voiceStartedAt && firstFinal ? firstFinal - voiceStartedAt : null,
    transcriptToDecisionMs: firstFinal && firstVerb ? firstVerb - firstFinal : null,
    decisionToFirstAudioMs: firstVerb && firstAudio ? firstAudio - firstVerb : null,
    totalMs: voiceStartedAt && firstAudio ? firstAudio - voiceStartedAt : null,
  };
}

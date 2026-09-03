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
import { nextSimulatedUserTurn, type SimulatedUserClient } from "./simulated-user";
import { synthesizeSpeech } from "./synthesize";
import type { ConversationTurn, CopilotRoundTrip, ScenarioRunResult, VoiceFrame, VoiceLatencies } from "./trace";

export interface RunnerOptions {
  deepgramApiKey: string;
  headless?: boolean;
  /** Overall per-run ceiling, ms — a real failure (hang, infinite loop)
   * degrades the run instead of blocking the suite forever. */
  timeoutMs?: number;
  /** How long the copilot/WS channel must go quiet before a run is
   * considered finished, ms. */
  quietMs?: number;
  /** Required only for a scenario that sets `simulatedUser` — the key the
   * simulated-user model itself is called with (simulated-user.ts). */
  anthropicApiKey?: string;
  /** DI hook for tests, same reasoning as judgeScenario's clientFactory —
   * no real ANTHROPIC_API_KEY exists anywhere in this repo. */
  simulatedUserClientFactory?: (apiKey: string) => SimulatedUserClient;
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
  let conversation: ConversationTurn[] | undefined;

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

    if (transport === "typed" && scenario.simulatedUser) {
      conversation = await runSimulatedUserConversation(
        page,
        scenario,
        roundTrips,
        () => lastActivityAt,
        () => {
          lastActivityAt = Date.now();
        },
        options,
      );
    } else if (transport === "typed") {
      await runTypedTurn(page, scenario.goal);
    } else if (scenario.simulatedUser) {
      // A real, deliberate scope limit, not an oversight — see
      // runSimulatedUserConversation's doc comment for why.
      throw new Error("runScenario: simulatedUser scenarios support the typed transport only");
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
    if (conversation) result.conversation = conversation;
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
      conversation,
      runError: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await browser.close();
  }
}

/**
 * τ-bench's pass^k (research item #5): runs the identical scenario k times
 * — sequentially, not parallel, both to avoid piling more load onto an
 * already rate-limited Groq account and to keep each trial's timing
 * independent — and returns every trial's full result, so the caller can
 * compute pass^k (judge.ts's `passAtK`) while still keeping each trial's
 * own trace for the dashboard's trial-level drill-down. Default k=3
 * matches the ad-hoc manual check that first built confidence in the
 * voice regression fix this session, now made a real, repeatable metric.
 */
export async function runScenarioRepeated(
  scenario: Scenario,
  transport: "typed" | "voice",
  k: number,
  options: RunnerOptions,
): Promise<ScenarioRunResult[]> {
  const results: ScenarioRunResult[] = [];
  for (let i = 0; i < k; i++) {
    results.push(await runScenario(scenario, transport, options));
  }
  return results;
}

async function openWidget(page: Page): Promise<void> {
  const toggle = page.locator('[aria-label="Open Cairn help"]');
  if (await toggle.count()) await toggle.click();
}

async function runTypedTurn(page: Page, goal: string, actionTimeoutMs?: number): Promise<void> {
  const input = page.locator('input[placeholder="What do you need help with?"]');
  // A real second/later turn (step 7's simulated-user work) can wait
  // longer for a real, possibly slow Groq round trip than Playwright's
  // default 30s action timeout allows — an explicit, larger, real budget
  // for a multi-turn conversation instead of the library's generic
  // default. (An earlier theory here — that a `tour` verb's spoken
  // narration keeps this input disabled long enough to matter — was
  // tested live and disproven: the input stayed visible/enabled
  // throughout. The real cause of the failure that prompted this is a
  // full page reload from the app's own action handlers, documented and
  // handled at the call site in runSimulatedUserConversation instead.)
  await input.fill(goal, actionTimeoutMs !== undefined ? { timeout: actionTimeoutMs } : undefined);
  const sendButton = page.locator('button[type="submit"]').last();
  await sendButton.click(actionTimeoutMs !== undefined ? { timeout: actionTimeoutMs } : undefined);
}

const DEFAULT_SIMULATED_USER_MAX_TURNS = 4;

/** τ-bench's simulated-user mode (research item #5) — drives the real
 * typed widget through a multi-turn back-and-forth instead of one fixed
 * message, reacting to Cairn's real replies via a separate model call
 * (simulated-user.ts) each turn. Typed transport only: voice would need
 * synthesizing each simulated-user reply to speech and re-arming the fake
 * mic mid-conversation — a real, larger piece of work than this pass
 * covers; scoped out deliberately rather than half-built (see
 * runScenario's own explicit error for the voice+simulatedUser case). */
async function runSimulatedUserConversation(
  page: Page,
  scenario: Scenario,
  roundTrips: CopilotRoundTrip[],
  getLastActivityAt: () => number,
  resetActivityClock: () => void,
  options: RunnerOptions,
): Promise<ConversationTurn[]> {
  const config = scenario.simulatedUser;
  if (!config) throw new Error("runSimulatedUserConversation: scenario has no simulatedUser config");
  if (!options.anthropicApiKey) throw new Error("runSimulatedUserConversation: options.anthropicApiKey is required for a simulated-user scenario");

  const maxTurns = config.maxTurns ?? DEFAULT_SIMULATED_USER_MAX_TURNS;
  const quietMs = options.quietMs ?? DEFAULT_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // One shared deadline for the WHOLE conversation, not a fresh timeoutMs
  // budget re-granted every turn — a real bug caught during this same live
  // check: maxTurns x timeoutMs could otherwise run far longer than the
  // per-run ceiling the rest of the suite assumes.
  const deadline = Date.now() + timeoutMs;
  const history: ConversationTurn[] = [];
  let nextMessage = config.opening;

  for (let turn = 0; turn < maxTurns; turn++) {
    const remainingMs = Math.max(1000, deadline - Date.now());
    const beforeCount = roundTrips.length;
    try {
      await runTypedTurn(page, nextMessage, remainingMs);
    } catch {
      // Real cause, found live: several of this playground app's own
      // onDo/action handlers (examples/demo-app's CopilotWithActions,
      // ArchiveInvoiceButton, etc.) call `window.location.reload()` after
      // a real write completes — which destroys the widget's own DOM/
      // conversation state mid-run. When the agent acts BEFORE asking
      // (the exact policy violation a scenario like this exists to
      // catch), that reload happens mid-conversation and this input
      // genuinely stops existing, not just "is slow." Treat that as the
      // conversation ending naturally, not a fatal run error — the
      // transcript captured so far (a real action with no clarifying
      // question) is itself the useful signal for the judge, not
      // something to discard by crashing the whole run.
      break;
    }
    history.push({ speaker: "simulated-user", text: nextMessage });
    // Same two real bugs already fixed once in runScenario's own main
    // wait (idle-clock started too early; quiet alone can't distinguish
    // "hasn't replied yet" from "done") — reusing waitUntilQuiet here
    // instead of re-deriving similar logic avoids reintroducing either.
    resetActivityClock();
    await waitUntilQuiet(getLastActivityAt, () => roundTrips.length > beforeCount, quietMs, Math.max(1000, deadline - Date.now()));

    if (roundTrips.length === beforeCount) break; // real timeout — no reply arrived this turn, stop rather than keep talking to a dead conversation
    const agentText = extractAgentText(roundTrips[roundTrips.length - 1].responseBody);
    if (!agentText) break; // nothing to react to — stop rather than send a blank/garbage next turn

    const priorHistory = [...history];
    history.push({ speaker: "agent", text: agentText });

    const turnResult = await nextSimulatedUserTurn(config, priorHistory, agentText, {
      apiKey: options.anthropicApiKey,
      clientFactory: options.simulatedUserClientFactory,
    });
    if (turnResult.done) break;
    nextMessage = turnResult.reply;
  }

  return history;
}

/** Pulls the real spoken/displayed text out of Cairn's forced-tool-call
 * verb response (packages/core's COMPANION_FIELDS `text`) — a `tour`
 * response carries its text per-step instead of at the top level, so that
 * case is joined separately. Exported for direct unit testing without a
 * real browser/page. */
export function extractAgentText(responseBody: unknown): string | null {
  if (!responseBody || typeof responseBody !== "object") return null;
  const body = responseBody as { text?: unknown; verb?: unknown; steps?: { text?: unknown }[] };
  if (typeof body.text === "string" && body.text) return body.text;
  if (body.verb === "tour" && Array.isArray(body.steps)) {
    const joined = body.steps
      .map((step) => (typeof step.text === "string" ? step.text : ""))
      .filter(Boolean)
      .join(" ");
    return joined || null;
  }
  return null;
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

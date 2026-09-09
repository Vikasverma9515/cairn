// Gemini-backed clients for judgeScenario/nextSimulatedUserTurn, shaped
// to satisfy their own existing JudgeClient/SimulatedUserClient interfaces
// unchanged — neither of those files needs to know or care which provider
// actually answered. Exists because no real ANTHROPIC_API_KEY is
// configured anywhere in this repo (confirmed live, not assumed — see
// DEVELOPMENT.md), while a real Gemini key already is. Both interfaces
// already accept `clientFactory` for exactly this kind of substitution
// (originally added so tests could run without a real Anthropic key);
// this is the same seam, used for a real provider instead of a test fake.
//
// Translates each Anthropic-shaped `messages.create(params)` call into a
// real `@google/genai` request and translates the response back into the
// same `{content: [...]}` shape both callers already parse — same
// forced-vs-unforced distinction GeminiVerbLLM/server.ts already
// established: judgeScenario always forces its one tool (`tool_choice`
// present), nextSimulatedUserTurn deliberately doesn't (the model can
// reply with plain text OR call `end_conversation`) — mapped to Gemini's
// `mode: "ANY"` vs the SDK's own default ("AUTO") respectively.
import { GoogleGenAI } from "@google/genai";

interface AnthropicShapedMessage {
  role: string;
  content: string;
}

interface AnthropicShapedTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicShapedParams {
  model: string;
  system?: string;
  tools?: AnthropicShapedTool[];
  tool_choice?: { type: string; name: string };
  messages: AnthropicShapedMessage[];
}

interface AnthropicShapedContentBlock {
  type: string;
  name?: string;
  input?: unknown;
  text?: string;
}

/** Real, live-found on the first eval run using this file (not
 * theoretical): Gemini's free tier caps at 15 requests/minute PER MODEL —
 * `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`, confirmed via the
 * real 429 body, which also carries a `RetryInfo.retryDelay` (typically
 * ~1-2s) saying almost exactly how long until the NEXT request in that
 * window would succeed. Honoring that real hint (falling back to a fixed
 * default only when it's missing/unparseable) recovers almost immediately
 * instead of guessing at backoff — this owns its OWN bounded retry policy
 * for exactly this, the same reason GeminiVerbLLM's clientFactory disables
 * the SDK's own blind 5-attempt retry (`httpOptions.retryOptions.attempts:
 * 1`) elsewhere in this codebase: one deliberate retry policy, not two
 * stacked ones. */
const MAX_RATE_LIMIT_RETRIES = 4;
const DEFAULT_RETRY_DELAY_MS = 2000;

function parseRetryDelayMs(err: unknown): number {
  if (!err || typeof err !== "object") return DEFAULT_RETRY_DELAY_MS;
  const message = typeof (err as { message?: unknown }).message === "string" ? (err as { message: string }).message : "";
  const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(Number(match[1]) * 1000) : DEFAULT_RETRY_DELAY_MS;
}

function isRateLimitOrOverloadedError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  return status === 429 || status === 503;
}

async function callGemini(apiKey: string, params: AnthropicShapedParams): Promise<{ content: AnthropicShapedContentBlock[] }> {
  // httpOptions.retryOptions.attempts: 1 — same real latency fix as
  // GeminiVerbLLM's own clientFactory (packages/sdk/src/server.ts) — the
  // SDK retries 5xx/429 up to 5 times internally by default with blind
  // exponential backoff; this function owns retry policy instead (see its
  // own doc comment above), honoring the real retryDelay hint rather than
  // guessing.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });
  const tool = params.tools?.[0];
  const forced = params.tool_choice?.type === "tool";

  const contents = params.messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const config: Record<string, unknown> = params.system ? { systemInstruction: params.system } : {};
  if (tool) {
    config.tools = [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.input_schema }] }];
    if (forced) config.toolConfig = { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [tool.name] } };
  }

  let response: Awaited<ReturnType<typeof ai.models.generateContent>> | undefined;
  for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
    try {
      response = await ai.models.generateContent({ model: params.model, contents, config });
      break;
    } catch (err) {
      if (!isRateLimitOrOverloadedError(err) || attempt === MAX_RATE_LIMIT_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, parseRetryDelayMs(err)));
    }
  }
  if (!response) throw new Error("callGemini: exhausted retries with no response");

  const content: AnthropicShapedContentBlock[] = [];
  const call = response.functionCalls?.[0];
  if (call?.name) content.push({ type: "tool_use", name: call.name, input: call.args });
  if (response.text) content.push({ type: "text", text: response.text });
  return { content };
}

/** Matches judge.ts's own `(apiKey: string) => JudgeClient` clientFactory
 * shape — pass as `judgeScenario`'s `options.clientFactory`, with
 * `options.model` set to a real Gemini model id (judgeScenario has no
 * Gemini-aware default of its own — see this module's own doc comment for
 * why that default stays Anthropic-shaped). */
export function createGeminiJudgeClient(apiKey: string): { messages: { create: (params: unknown) => Promise<{ content: AnthropicShapedContentBlock[] }> } } {
  return { messages: { create: (params) => callGemini(apiKey, params as AnthropicShapedParams) } };
}

/** Matches simulated-user.ts's own `(apiKey: string) => SimulatedUserClient`
 * clientFactory shape — same reasoning as createGeminiJudgeClient. */
export function createGeminiSimulatedUserClient(apiKey: string): { messages: { create: (params: unknown) => Promise<{ content: AnthropicShapedContentBlock[] }> } } {
  return { messages: { create: (params) => callGemini(apiKey, params as AnthropicShapedParams) } };
}

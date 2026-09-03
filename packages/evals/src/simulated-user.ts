// τ-bench's simulated-user mode (research item #5): a separate model plays
// a real persona with a private goal and private context, and reacts to
// Cairn's real agent turn by turn — tests real multi-turn negotiation
// (clarifying questions, confirmations), not just single-shot instruction
// following. Same forced-tool-call-for-a-terminal-signal pattern as
// judge.ts (a real "end_conversation" tool call beats parsing free text
// for "are we done"), and the same injectable-client DI pattern as
// judgeScenario/GroqVerbLLM, for the same reason: no real ANTHROPIC_API_KEY
// exists anywhere in this repo, so this needs to be testable without one.
import Anthropic from "@anthropic-ai/sdk";
import type { ConversationTurn } from "./trace";
import type { SimulatedUserConfig } from "./scenario";

const END_TOOL_NAME = "end_conversation";

/** Minimal shape this module needs — narrow enough to fake in tests,
 * mirrors judge.ts's JudgeClient. */
export interface SimulatedUserClient {
  messages: {
    create: (params: unknown) => Promise<{ content: { type: string; name?: string; text?: string }[] }>;
  };
}

export type SimulatedUserTurnResult = { done: true } | { done: false; reply: string };

/** Plays one simulated-user turn: given the conversation so far and the
 * real agent's latest message, returns either the persona's next reply or
 * a signal that the conversation is over (goal satisfied, or genuinely
 * stuck) — a real model decision, not a scripted response, so this
 * actually exercises multi-turn negotiation instead of replaying a fixed
 * script. */
export async function nextSimulatedUserTurn(
  config: SimulatedUserConfig,
  history: ConversationTurn[],
  agentMessage: string,
  options: { apiKey: string; model?: string; clientFactory?: (apiKey: string) => SimulatedUserClient },
): Promise<SimulatedUserTurnResult> {
  const makeClient: (apiKey: string) => SimulatedUserClient = options.clientFactory ?? ((apiKey) => new Anthropic({ apiKey }) as unknown as SimulatedUserClient);
  const client = makeClient(options.apiKey);
  const model = options.model ?? "claude-opus-5";

  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: buildPersonaSystemPrompt(config),
    tools: [
      {
        name: END_TOOL_NAME,
        description:
          "Call this instead of replying when your goal has genuinely been satisfied by what the agent has done, or the conversation is stuck and continuing wouldn't help.",
        input_schema: { type: "object", properties: {}, required: [] },
      },
    ],
    messages: [...toAnthropicMessages(history), { role: "user", content: agentMessage }],
  });

  const endCall = response.content.find((block) => block.type === "tool_use" && block.name === END_TOOL_NAME);
  if (endCall) return { done: true };

  const textBlock = response.content.find((block) => block.type === "text" && block.text);
  if (!textBlock?.text) throw new Error("nextSimulatedUserTurn: model returned neither a reply nor an end_conversation call");
  return { done: false, reply: textBlock.text };
}

/** History is stored from the HARNESS's point of view (`speaker:
 * "simulated-user" | "agent"`); this call is made FROM the simulated
 * user's point of view, so the roles invert: its own past replies are
 * "assistant" turns, the real agent's past messages are "user" turns. */
function toAnthropicMessages(history: ConversationTurn[]): { role: "user" | "assistant"; content: string }[] {
  return history.map((turn) => ({ role: turn.speaker === "agent" ? "user" : "assistant", content: turn.text }));
}

function buildPersonaSystemPrompt(config: SimulatedUserConfig): string {
  return `You are roleplaying as a real person talking to an AI agent that operates software on your behalf. Stay fully in character — short, conversational replies, no markdown, the way a real person types or speaks.

Your goal: ${config.opening}

Private context only you know (use it to answer the agent's questions naturally — never volunteer it unprompted, and never say you were "told" this): ${config.privateContext}

If the agent asks a clarifying question, answer it from your private context. If your goal has been fully satisfied by what the agent has done so far, call end_conversation instead of replying. If this genuinely isn't going anywhere, also call end_conversation rather than repeating yourself.`;
}

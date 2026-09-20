// L4 model client: one forced tool call that returns structured JSON. Same three providers, same key
// rotation and invalid-key handling as the L3 describe clients (llm.ts); rate limits are retried one
// layer up by concurrency.ts's withRetry.

import Anthropic from "@anthropic-ai/sdk";
import { FunctionCallingConfigMode, GoogleGenAI } from "@google/genai";
import Groq from "groq-sdk";
import { KeyRotator } from "./key-rotator";

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface SkillWriterClient {
  /** Forces one call to `tool` and returns its parsed arguments. */
  callTool(system: string, user: string, tool: ToolSpec): Promise<unknown>;
}

const invalidKey = (err: unknown): boolean => {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; error?: { code?: unknown; error?: { code?: unknown } }; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  return (
    e.status === 401 ||
    (e.status === 400 && (message.includes("API_KEY_INVALID") || message.includes("API key not valid"))) ||
    (e.code ?? e.error?.code ?? e.error?.error?.code) === "invalid_api_key" ||
    message.includes("invalid_api_key")
  );
};

export class AnthropicSkillWriter implements SkillWriterClient {
  private client: Anthropic;
  private model: string;
  constructor(options?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic({ apiKey: options?.apiKey });
    this.model = options?.model ?? process.env.CAIRN_DESCRIBE_MODEL ?? "claude-opus-5";
  }
  async callTool(system: string, user: string, tool: ToolSpec): Promise<unknown> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 8000,
      system,
      tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: tool.name },
      messages: [{ role: "user", content: user }],
    });
    const use = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === tool.name);
    if (!use) throw new Error(`L4 skills: no ${tool.name} tool_use block in the response`);
    return use.input;
  }
}

export class GroqSkillWriter implements SkillWriterClient {
  private keys: KeyRotator;
  private model: string;
  constructor(options?: { apiKeys?: string[]; model?: string }) {
    const rotator = options?.apiKeys ? new KeyRotator(options.apiKeys) : KeyRotator.fromEnvList(process.env.GROQ_API_KEYS);
    if (!rotator) throw new Error("GroqSkillWriter: no API key — set GROQ_API_KEYS");
    this.keys = rotator;
    this.model = options?.model ?? process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";
  }
  async callTool(system: string, user: string, tool: ToolSpec): Promise<unknown> {
    const attempts = Math.max(this.keys.size, 1);
    for (let attempt = 0; ; attempt++) {
      const key = this.keys.take();
      try {
        const completion = await new Groq({ apiKey: key, maxRetries: 0 }).chat.completions.create({
          model: this.model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.schema } }],
          tool_choice: { type: "function", function: { name: tool.name } },
        });
        const call = completion.choices[0]?.message?.tool_calls?.[0];
        if (!call) throw new Error(`L4 skills (groq): no tool call in the response`);
        return JSON.parse(call.function.arguments);
      } catch (err) {
        if (invalidKey(err)) {
          this.keys.markDead(key);
          if (attempt < attempts - 1) continue;
        }
        throw err;
      }
    }
  }
}

export class GeminiSkillWriter implements SkillWriterClient {
  private keys: KeyRotator;
  private model: string;
  constructor(options?: { apiKeys?: string[]; model?: string }) {
    const rotator = options?.apiKeys ? new KeyRotator(options.apiKeys) : KeyRotator.fromEnvList(process.env.GEMINI_API_KEYS ?? process.env.GEMINI_API_KEY);
    if (!rotator) throw new Error("GeminiSkillWriter: no API key — set GEMINI_API_KEY(S)");
    this.keys = rotator;
    this.model = options?.model ?? process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";
  }
  async callTool(system: string, user: string, tool: ToolSpec): Promise<unknown> {
    const attempts = Math.max(this.keys.size, 1);
    for (let attempt = 0; ; attempt++) {
      const key = this.keys.take();
      try {
        const response = await new GoogleGenAI({ apiKey: key, httpOptions: { retryOptions: { attempts: 1 } } }).models.generateContent({
          model: this.model,
          contents: user,
          config: {
            systemInstruction: system,
            tools: [{ functionDeclarations: [{ name: tool.name, description: tool.description, parametersJsonSchema: tool.schema }] }],
            toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [tool.name] } },
          },
        });
        const call = response.functionCalls?.find((c) => c.name === tool.name) ?? response.functionCalls?.[0];
        if (!call?.args) throw new Error(`L4 skills (gemini): no function call in the response`);
        return call.args;
      } catch (err) {
        if (invalidKey(err)) {
          this.keys.markDead(key);
          if (attempt < attempts - 1) continue;
        }
        throw err;
      }
    }
  }
}

export function createSkillWriter(provider: "anthropic" | "groq" | "gemini"): SkillWriterClient {
  return provider === "groq" ? new GroqSkillWriter() : provider === "gemini" ? new GeminiSkillWriter() : new AnthropicSkillWriter();
}

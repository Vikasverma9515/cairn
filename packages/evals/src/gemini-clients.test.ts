// Confirms the shim actually translates both directions correctly —
// judgeScenario/nextSimulatedUserTurn build Anthropic-shaped params and
// parse an Anthropic-shaped response back; these adapters sit in between
// and must satisfy both ends without either caller knowing a different
// provider answered. Doesn't hit the real Gemini API — same "fake the
// client, not the network" discipline server.ts's own GeminiVerbLLM tests
// use (see packages/sdk/src/server.test.ts).
import { describe, expect, it, vi } from "vitest";
import { createGeminiJudgeClient, createGeminiSimulatedUserClient } from "./gemini-clients";

vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: {
        generateContent: vi.fn(async (params: any) => {
          (globalThis as any).__lastGenerateContentParams = params;
          const queue = (globalThis as any).__geminiResponseQueue as unknown[];
          const next = queue.shift();
          if (next instanceof Error) throw next;
          return next;
        }),
      },
    })),
  };
});

function setNextGeminiResponse(response: unknown) {
  (globalThis as any).__geminiResponseQueue = [response];
}

function queueGeminiResponses(...responses: unknown[]) {
  (globalThis as any).__geminiResponseQueue = responses;
}

describe("createGeminiJudgeClient", () => {
  it("translates a forced tool_choice call into Gemini's forced functionCallingConfig, and the real functionCall.args back into an Anthropic-shaped tool_use block", async () => {
    setNextGeminiResponse({ functionCalls: [{ name: "submit_verdict", args: { taskSuccess: 1, pass: true } }] });
    const client = createGeminiJudgeClient("fake-key");
    const result = await client.messages.create({
      model: "gemini-flash-lite-latest",
      system: "You are a judge.",
      tools: [{ name: "submit_verdict", description: "Submit it.", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "tool", name: "submit_verdict" },
      messages: [{ role: "user", content: "{}" }],
    });
    expect(result.content).toEqual([{ type: "tool_use", name: "submit_verdict", input: { taskSuccess: 1, pass: true } }]);

    const seenParams = (globalThis as any).__lastGenerateContentParams;
    expect(seenParams.config.toolConfig).toEqual({ functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["submit_verdict"] } });
    expect(seenParams.config.tools[0].functionDeclarations[0].name).toBe("submit_verdict");
  });

  it("maps assistant/user roles onto Gemini's model/user roles", async () => {
    setNextGeminiResponse({ functionCalls: [{ name: "x", args: {} }] });
    const client = createGeminiJudgeClient("fake-key");
    await client.messages.create({
      model: "m",
      tools: [{ name: "x", description: "d", input_schema: {} }],
      tool_choice: { type: "tool", name: "x" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    const seenParams = (globalThis as any).__lastGenerateContentParams;
    expect(seenParams.contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
      { role: "model", parts: [{ text: "hello" }] },
    ]);
  });
});

describe("createGeminiSimulatedUserClient", () => {
  it("an UNFORCED call (no tool_choice) does not set Gemini's toolConfig — matches nextSimulatedUserTurn's own auto-mode call shape", async () => {
    setNextGeminiResponse({ text: "Sure, sounds good." });
    const client = createGeminiSimulatedUserClient("fake-key");
    const result = await client.messages.create({
      model: "m",
      system: "You are a persona.",
      tools: [{ name: "end_conversation", description: "d", input_schema: { type: "object", properties: {}, required: [] } }],
      messages: [{ role: "user", content: "Did that work?" }],
    });
    expect(result.content).toEqual([{ type: "text", text: "Sure, sounds good." }]);
    const seenParams = (globalThis as any).__lastGenerateContentParams;
    expect(seenParams.config.toolConfig).toBeUndefined();
  });

  it("a real end_conversation call comes back as a tool_use block, same shape nextSimulatedUserTurn already checks for", async () => {
    setNextGeminiResponse({ functionCalls: [{ name: "end_conversation", args: {} }] });
    const client = createGeminiSimulatedUserClient("fake-key");
    const result = await client.messages.create({
      model: "m",
      tools: [{ name: "end_conversation", description: "d", input_schema: { type: "object", properties: {}, required: [] } }],
      messages: [{ role: "user", content: "All done." }],
    });
    expect(result.content).toEqual([{ type: "tool_use", name: "end_conversation", input: {} }]);
  });
});

describe("callGemini's own retry policy — real, live-found on the first eval run using this file: Gemini's free tier caps at 15 requests/minute per model", () => {
  it("a real 429 with a parseable retryDelay hint retries after that exact delay and succeeds", async () => {
    vi.useFakeTimers();
    const rateLimitErr: any = new Error(
      '{"error":{"code":429,"message":"Quota exceeded...","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"1.5s"}]}}',
    );
    rateLimitErr.status = 429;
    queueGeminiResponses(rateLimitErr, { functionCalls: [{ name: "submit_verdict", args: { pass: true } }] });

    const client = createGeminiJudgeClient("fake-key");
    const promise = client.messages.create({
      model: "m",
      tools: [{ name: "submit_verdict", description: "d", input_schema: {} }],
      tool_choice: { type: "tool", name: "submit_verdict" },
      messages: [{ role: "user", content: "{}" }],
    });
    await vi.advanceTimersByTimeAsync(1500);
    const result = await promise;
    expect(result.content).toEqual([{ type: "tool_use", name: "submit_verdict", input: { pass: true } }]);
    vi.useRealTimers();
  });

  it("exhausts its bounded retry budget on a persistent 429, then throws — never retries forever", async () => {
    vi.useFakeTimers();
    const rateLimitErr: any = new Error("Quota exceeded");
    rateLimitErr.status = 429;
    queueGeminiResponses(rateLimitErr, rateLimitErr, rateLimitErr, rateLimitErr, rateLimitErr, rateLimitErr);

    const client = createGeminiJudgeClient("fake-key");
    const promise = client.messages
      .create({
        model: "m",
        tools: [{ name: "x", description: "d", input_schema: {} }],
        tool_choice: { type: "tool", name: "x" },
        messages: [{ role: "user", content: "{}" }],
      })
      .catch((err) => err);
    await vi.advanceTimersByTimeAsync(60000);
    const result = await promise;
    expect(result).toBeInstanceOf(Error);
    vi.useRealTimers();
  });

  it("a non-rate-limit error (e.g. a real 400) is never retried — fails immediately", async () => {
    const badRequestErr: any = new Error("Bad request");
    badRequestErr.status = 400;
    queueGeminiResponses(badRequestErr);

    const client = createGeminiJudgeClient("fake-key");
    await expect(
      client.messages.create({
        model: "m",
        tools: [{ name: "x", description: "d", input_schema: {} }],
        tool_choice: { type: "tool", name: "x" },
        messages: [{ role: "user", content: "{}" }],
      }),
    ).rejects.toThrow("Bad request");
  });
});

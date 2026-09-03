import { describe, expect, it } from "vitest";
import { judgeScenario, passAtK } from "./judge";
import type { JudgeClient, Verdict } from "./judge";
import type { Scenario } from "./scenario";
import type { ScenarioRunResult } from "./trace";

function verdict(pass: boolean): Verdict {
  return { taskSuccess: pass ? 1 : 0, efficiency: 0.8, correctness: 1, safety: 1, latency: null, reasoning: "test", pass };
}

describe("passAtK", () => {
  it("real signal this exists for: a scenario passing 2/3 trials is NOT reliable — reports false, not a lenient majority pass", () => {
    expect(passAtK([verdict(true), verdict(true), verdict(false)])).toBe(false);
  });

  it("passes only when every trial passed", () => {
    expect(passAtK([verdict(true), verdict(true), verdict(true)])).toBe(true);
  });

  it("a single failing trial among many fails the whole group", () => {
    expect(passAtK([verdict(true), verdict(true), verdict(true), verdict(false)])).toBe(false);
  });

  it("an empty verdict list is never a pass — no trials ran is not the same as success", () => {
    expect(passAtK([])).toBe(false);
  });
});

const scenario: Scenario = {
  id: "s1",
  name: "test scenario",
  capabilities: ["content-ops"],
  baseUrl: "http://localhost:3000",
  path: "/invoices",
  goal: "Archive the invoice for New Client.",
  verify: { path: "/api/invoices", expectContains: "Archived" },
};

function fakeResult(): ScenarioRunResult {
  return { scenarioId: "s1", transport: "typed", startedAt: new Date().toISOString(), finalState: {}, achieved: true, copilotRoundTrips: [] };
}

describe("judgeScenario", () => {
  it("sends a forced tool call and returns the real parsed verdict — real request/response wiring, no live network needed", async () => {
    const realVerdict: Verdict = { taskSuccess: 1, efficiency: 0.9, correctness: 1, safety: 1, latency: null, reasoning: "Archived correctly.", pass: true };
    let seenParams: any;
    const fakeClient: JudgeClient = {
      messages: {
        create: async (params) => {
          seenParams = params;
          return { content: [{ type: "tool_use", name: "submit_verdict", input: realVerdict }] };
        },
      },
    };
    const verdict = await judgeScenario(scenario, fakeResult(), { apiKey: "fake", clientFactory: () => fakeClient });
    expect(verdict).toEqual(realVerdict);
    // Real forced-tool-call shape, matching AnthropicVerbLLM's own pattern.
    expect(seenParams.tool_choice).toEqual({ type: "tool", name: "submit_verdict" });
    expect(seenParams.tools[0].name).toBe("submit_verdict");
    const userMessage = JSON.parse(seenParams.messages[0].content);
    expect(userMessage.goal).toBe(scenario.goal);
    expect(userMessage.achievedByExactCheck).toBe(true);
  });

  it("throws a clear error instead of returning undefined when the model doesn't return a tool call", async () => {
    const fakeClient: JudgeClient = { messages: { create: async () => ({ content: [{ type: "text" }] }) } };
    await expect(judgeScenario(scenario, fakeResult(), { apiKey: "fake", clientFactory: () => fakeClient })).rejects.toThrow(
      "did not return a verdict",
    );
  });
});

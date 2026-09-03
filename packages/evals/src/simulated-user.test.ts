import { describe, expect, it } from "vitest";
import { nextSimulatedUserTurn } from "./simulated-user";
import type { SimulatedUserClient } from "./simulated-user";
import type { SimulatedUserConfig } from "./scenario";
import type { ConversationTurn } from "./trace";

const config: SimulatedUserConfig = {
  opening: "I want my old invoices cleaned up.",
  privateContext: "If asked about anything over $1000, say yes, go ahead and archive it.",
  maxTurns: 4,
};

describe("nextSimulatedUserTurn", () => {
  it("returns a real reply when the model responds with text — real request wiring, no live network needed", async () => {
    let seenParams: any;
    const fakeClient: SimulatedUserClient = {
      messages: {
        create: async (params) => {
          seenParams = params;
          return { content: [{ type: "text", text: "Yes, go ahead and archive it." }] };
        },
      },
    };
    const result = await nextSimulatedUserTurn(config, [], "That invoice is over $1000 — should I archive it?", {
      apiKey: "fake",
      clientFactory: () => fakeClient,
    });
    expect(result).toEqual({ done: false, reply: "Yes, go ahead and archive it." });
    // Real persona + private context reach the model, not a placeholder.
    expect(seenParams.system).toContain(config.opening);
    expect(seenParams.system).toContain(config.privateContext);
    // The real end-signal tool is offered every turn.
    expect(seenParams.tools[0].name).toBe("end_conversation");
    // The agent's latest message is the final user turn sent.
    expect(seenParams.messages.at(-1)).toEqual({ role: "user", content: "That invoice is over $1000 — should I archive it?" });
  });

  it("inverts speaker roles for the simulated-user's own call — its past replies are 'assistant', the agent's past messages are 'user'", async () => {
    let seenParams: any;
    const history: ConversationTurn[] = [
      { speaker: "agent", text: "Which invoices should I archive?" },
      { speaker: "simulated-user", text: "The old ones." },
    ];
    const fakeClient: SimulatedUserClient = {
      messages: {
        create: async (params) => {
          seenParams = params;
          return { content: [{ type: "text", text: "ok" }] };
        },
      },
    };
    await nextSimulatedUserTurn(config, history, "Got it, archiving now.", { apiKey: "fake", clientFactory: () => fakeClient });
    expect(seenParams.messages[0]).toEqual({ role: "user", content: "Which invoices should I archive?" });
    expect(seenParams.messages[1]).toEqual({ role: "assistant", content: "The old ones." });
  });

  it("returns done:true when the model calls end_conversation instead of replying", async () => {
    const fakeClient: SimulatedUserClient = {
      messages: { create: async () => ({ content: [{ type: "tool_use", name: "end_conversation" }] }) },
    };
    const result = await nextSimulatedUserTurn(config, [], "All done — archived both invoices.", { apiKey: "fake", clientFactory: () => fakeClient });
    expect(result).toEqual({ done: true });
  });

  it("throws a clear error instead of silently returning nothing when the model gives neither a reply nor an end signal", async () => {
    const fakeClient: SimulatedUserClient = { messages: { create: async () => ({ content: [] }) } };
    await expect(nextSimulatedUserTurn(config, [], "hello", { apiKey: "fake", clientFactory: () => fakeClient })).rejects.toThrow(
      "neither a reply nor an end_conversation call",
    );
  });
});

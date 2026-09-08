import { describe, expect, it } from "vitest";
import { GeminiDescribeClient, GroqDescribeClient, type DescribeInput, type GeminiLikeClient, type GroqLikeClient } from "./llm";

const input: DescribeInput = {
  route: "/invoices",
  file: "app/invoices/page.tsx",
  source: "export default function Page() { return null; }",
  elements: [],
};

function toolCallResponse(args: Record<string, unknown>) {
  return { choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(args) } }] } }] };
}

const realDescription = {
  title: "Invoices",
  purpose: "Lists invoices.",
  whenToUse: "Check payments.",
  confidence: 0.9,
  elements: [],
};

describe("GroqDescribeClient", () => {
  it("describes a page via a real tool call", async () => {
    const fakeClient: GroqLikeClient = { chat: { completions: { create: async () => toolCallResponse(realDescription) } } };
    const client = new GroqDescribeClient({ apiKeys: ["fake-key"] }, () => fakeClient);
    const result = await client.describePage(input);
    expect(result.title).toBe("Invoices");
  });

  it("real, live-found fix: a 401 (invalid key) retries on a different configured key and marks the dead one so it's excluded from every later call", async () => {
    const seenKeys: string[] = [];
    const client = new GroqDescribeClient({ apiKeys: ["key-a", "key-b"] }, (key) => {
      seenKeys.push(key);
      if (key === "key-a") {
        const err: any = new Error("401");
        err.status = 401;
        throw err;
      }
      return { chat: { completions: { create: async () => toolCallResponse(realDescription) } } };
    });
    const result = await client.describePage(input);
    expect(result.title).toBe("Invoices");
    expect(seenKeys).toEqual(["key-a", "key-b"]);
  });

  it("a key confirmed dead on one page is never handed out again on a LATER page's describePage call", async () => {
    const seenKeys: string[] = [];
    const client = new GroqDescribeClient({ apiKeys: ["key-a", "key-b"] }, (key) => {
      seenKeys.push(key);
      if (key === "key-a") {
        const err: any = new Error("401");
        err.status = 401;
        throw err;
      }
      return { chat: { completions: { create: async () => toolCallResponse(realDescription) } } };
    });
    await client.describePage(input); // key-a fails and gets marked dead, key-b succeeds
    await client.describePage({ ...input, route: "/dashboard" }); // a later, separate page
    await client.describePage({ ...input, route: "/board" });
    expect(seenKeys).toEqual(["key-a", "key-b", "key-b", "key-b"]);
  });

  it("exhausts every configured key on persistent invalid-key failures, then throws the last error", async () => {
    let attempts = 0;
    const client = new GroqDescribeClient({ apiKeys: ["key-a", "key-b", "key-c"] }, () => ({
      chat: {
        completions: {
          create: async () => {
            attempts++;
            const err: any = new Error("401");
            err.status = 401;
            throw err;
          },
        },
      },
    }));
    await expect(client.describePage(input)).rejects.toThrow("401");
    expect(attempts).toBe(3);
  });

  it("a rate-limit error (429) is NOT retried by describePage itself — that's withRetry's own job at the caller, a different concern", async () => {
    let attempts = 0;
    const client = new GroqDescribeClient({ apiKeys: ["key-a", "key-b"] }, () => ({
      chat: {
        completions: {
          create: async () => {
            attempts++;
            const err: any = new Error("429");
            err.status = 429;
            throw err;
          },
        },
      },
    }));
    await expect(client.describePage(input)).rejects.toThrow("429");
    expect(attempts).toBe(1); // no internal retry — a 429 isn't a dead-key condition
  });

  it("throws a real, clear error when no tool call comes back", async () => {
    const client = new GroqDescribeClient({ apiKeys: ["fake-key"] }, () => ({
      chat: { completions: { create: async () => ({ choices: [{ message: {} }] }) } },
    }));
    await expect(client.describePage(input)).rejects.toThrow("no tool call");
  });
});

function functionCallResponse(args: Record<string, unknown>) {
  return { functionCalls: [{ name: "describe_page", args }] };
}

describe("GeminiDescribeClient", () => {
  it("describes a page via a real function call — args come back already parsed, unlike Groq's stringified arguments", async () => {
    const fakeClient: GeminiLikeClient = { models: { generateContent: async () => functionCallResponse(realDescription) } };
    const client = new GeminiDescribeClient({ apiKeys: ["fake-key"] }, () => fakeClient);
    const result = await client.describePage(input);
    expect(result.title).toBe("Invoices");
  });

  it("real, confirmed-live convention: Gemini's invalid-key error is a 400 (not 401) with 'API_KEY_INVALID' in the message — retries on a different configured key and marks the dead one so it's excluded from every later call", async () => {
    const seenKeys: string[] = [];
    const client = new GeminiDescribeClient({ apiKeys: ["key-a", "key-b"] }, (key) => {
      seenKeys.push(key);
      if (key === "key-a") {
        const err: any = new Error('{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}');
        err.status = 400;
        throw err;
      }
      return { models: { generateContent: async () => functionCallResponse(realDescription) } };
    });
    const result = await client.describePage(input);
    expect(result.title).toBe("Invoices");
    expect(seenKeys).toEqual(["key-a", "key-b"]);
  });

  it("a key confirmed dead on one page is never handed out again on a LATER page's describePage call", async () => {
    const seenKeys: string[] = [];
    const client = new GeminiDescribeClient({ apiKeys: ["key-a", "key-b"] }, (key) => {
      seenKeys.push(key);
      if (key === "key-a") {
        const err: any = new Error("API key not valid. Please pass a valid API key.");
        err.status = 400;
        throw err;
      }
      return { models: { generateContent: async () => functionCallResponse(realDescription) } };
    });
    await client.describePage(input);
    await client.describePage({ ...input, route: "/dashboard" });
    await client.describePage({ ...input, route: "/board" });
    expect(seenKeys).toEqual(["key-a", "key-b", "key-b", "key-b"]);
  });

  it("exhausts every configured key on persistent invalid-key failures, then throws the last error", async () => {
    let attempts = 0;
    const client = new GeminiDescribeClient({ apiKeys: ["key-a", "key-b", "key-c"] }, () => ({
      models: {
        generateContent: async () => {
          attempts++;
          const err: any = new Error("API key not valid.");
          err.status = 400;
          throw err;
        },
      },
    }));
    await expect(client.describePage(input)).rejects.toThrow("API key not valid");
    expect(attempts).toBe(3);
  });

  it("a rate-limit error (429) is NOT retried by describePage itself — that's withRetry's own job at the caller, a different concern (same contract as GroqDescribeClient)", async () => {
    let attempts = 0;
    const client = new GeminiDescribeClient({ apiKeys: ["key-a", "key-b"] }, () => ({
      models: {
        generateContent: async () => {
          attempts++;
          const err: any = new Error("429");
          err.status = 429;
          throw err;
        },
      },
    }));
    await expect(client.describePage(input)).rejects.toThrow("429");
    expect(attempts).toBe(1);
  });

  it("throws a real, clear error when no function call comes back", async () => {
    const client = new GeminiDescribeClient({ apiKeys: ["fake-key"] }, () => ({
      models: { generateContent: async () => ({}) },
    }));
    await expect(client.describePage(input)).rejects.toThrow("no function call");
  });
});

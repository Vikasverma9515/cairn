import { describe, expect, it } from "vitest";
import { GroqDescribeClient, type DescribeInput, type GroqLikeClient } from "./llm";

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

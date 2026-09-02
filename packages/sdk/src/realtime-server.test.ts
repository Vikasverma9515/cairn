import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { HistoryTurn, Manifest } from "@cairnvibe/core";
import type { VerbLLM } from "./server";
import { handleDeepgramMessage, type ConnectionDeps } from "./realtime-server";

const manifest: Manifest = {
  version: "1",
  commit: "test",
  generatedAt: new Date().toISOString(),
  pages: [],
  dead: [],
  conflicts: [],
};

function fakeClient() {
  const sent: unknown[] = [];
  const client = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => sent.push(JSON.parse(data))),
  } as unknown as WebSocket;
  return { client, sent };
}

function fakeDeps(respond: VerbLLM["respond"]): ConnectionDeps {
  return {
    deepgramApiKey: "test-key",
    sttModel: "nova-2",
    ttsVoice: "aura-2-thalia-en",
    llm: { respond },
    systemPrompt: "test prompt",
    manifest,
    registeredActions: [],
    capability: "act",
  };
}

const getContext = () => ({ route: "/", visible: [] as string[], liveElements: [], webMcpTools: [] });
const neverCalledWaitForToolResult = () => {
  throw new Error("waitForToolResult should not be called for a terminal-verb-only turn");
};

function resultsMessage(transcript: string, opts: { isFinal: boolean; speechFinal?: boolean }): string {
  return JSON.stringify({
    type: "Results",
    is_final: opts.isFinal,
    speech_final: opts.speechFinal ?? false,
    channel: { alternatives: [{ transcript }] },
  });
}

describe("handleDeepgramMessage", () => {
  it("a single speech_final segment triggers exactly one turn", async () => {
    const { client, sent } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "hi there" });
    const deps = fakeDeps(respond);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(
      resultsMessage("hello", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      history,
      turnState,
      () => 0,
      neverCalledWaitForToolResult,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    const finals = sent.filter((m: any) => m.type === "final");
    expect(finals).toEqual([{ type: "final", text: "hello" }]);
  });

  it("real bug: two is_final chunks for ONE utterance (a natural mid-sentence pause) do NOT trigger two turns — only the speech_final one does", async () => {
    // This is exactly what was observed live: Deepgram finalizing "hello"
    // as a stable transcript chunk with is_final:true but speech_final:
    // false (no real pause detected yet), then continuing to finalize more
    // of the same utterance. Reacting to every is_final was firing an
    // independent LLM+TTS turn per chunk — the literal cause of the
    // duplicated transcript entries and the agent audibly speaking twice.
    const { client, sent } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "ok" });
    const deps = fakeDeps(respond);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(resultsMessage("hello", { isFinal: true, speechFinal: false }), client, deps, getContext, async () => {}, history, turnState, () => 0, neverCalledWaitForToolResult);
    expect(respond).not.toHaveBeenCalled();
    expect(sent.some((m: any) => m.type === "final")).toBe(false);
    expect(turnState.buffer).toBe("hello");

    await handleDeepgramMessage(
      resultsMessage("can you help me", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      history,
      turnState,
      () => 0,
      neverCalledWaitForToolResult,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    // The two chunks accumulate into one complete question, not two.
    const finals = sent.filter((m: any) => m.type === "final");
    expect(finals).toEqual([{ type: "final", text: "hello can you help me" }]);
    expect(turnState.buffer).toBe(""); // consumed, ready for the next turn
  });

  it("an UtteranceEnd message flushes a buffered-but-never-speech_final chunk instead of losing it", async () => {
    const { client, sent } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "ok" });
    const deps = fakeDeps(respond);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(resultsMessage("are you there", { isFinal: true, speechFinal: false }), client, deps, getContext, async () => {}, history, turnState, () => 0, neverCalledWaitForToolResult);
    expect(respond).not.toHaveBeenCalled();

    await handleDeepgramMessage(JSON.stringify({ type: "UtteranceEnd" }), client, deps, getContext, async () => {}, history, turnState, () => 0, neverCalledWaitForToolResult);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(sent.filter((m: any) => m.type === "final")).toEqual([{ type: "final", text: "are you there" }]);
  });

  it("a barge-in (generation bump) while resolveVerb is in flight drops the now-stale verb and speech instead of delivering them late", async () => {
    const { client, sent } = fakeClient();
    let generation = 0;
    // Simulates the barge-in happening WHILE the LLM call is in flight —
    // the generation the caller reads has already moved on by the time
    // resolveVerb resolves.
    const respond = vi.fn().mockImplementation(async () => {
      generation++;
      return { verb: "explain", text: "a stale answer nobody should hear" };
    });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(
      resultsMessage("question", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      speakStreamed,
      history,
      turnState,
      () => generation,
      neverCalledWaitForToolResult,
    );

    expect(sent.some((m: any) => m.type === "verb")).toBe(false);
    expect(speakStreamed).not.toHaveBeenCalled();
    // The user's own speech was still transcribed and shown — only the
    // (now-superseded) response is dropped.
    expect(sent.some((m: any) => m.type === "final")).toBe(true);
  });

  const getContextWithArchiveBtn = () => ({
    route: "/",
    visible: [] as string[],
    liveElements: [{ id: "archive-btn", role: "button", label: "Archive" }],
    webMcpTools: [],
  });

  it("agent loop: a continuing verb (click) is sent to the client, waits for its real result, then calls the model again to get the terminal answer", async () => {
    const { client, sent } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async (_systemPrompt: string, userMessage: string) => {
      call++;
      if (call === 1) return { verb: "click", target: "archive-btn" };
      // Second call — the loop should have folded the real click result into history.
      const parsed = JSON.parse(userMessage);
      expect(parsed.history.at(-1).text).toContain("Result: Archived, status now Archived");
      return { verb: "explain", text: "Done, I archived it." };
    });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("Archived, status now Archived");

    await handleDeepgramMessage(
      resultsMessage("archive the overdue invoice", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    expect(respond).toHaveBeenCalledTimes(2);
    expect(waitForToolResult).toHaveBeenCalledTimes(1);
    const verbMessages = sent.filter((m: any) => m.type === "verb");
    expect(verbMessages).toEqual([
      { type: "verb", verb: { verb: "click", target: "archive-btn" } },
      { type: "verb", verb: { verb: "explain", text: "Done, I archived it." } },
    ]);
    expect(speakStreamed).toHaveBeenCalledWith("Done, I archived it.");
    // Only the real final answer lands in the connection's own memory —
    // not the intermediate click step.
    expect(history).toEqual([
      { role: "user", text: "archive the overdue invoice" },
      { role: "assistant", text: "Done, I archived it." },
    ]);
  });

  it("Talker ack: a multi-step turn speaks a quick acknowledgment BEFORE the real answer, exactly twice — never more, even with several continuing steps", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) return { verb: "read", target: "archive-btn" }; // two continuing steps
      return { verb: "explain", text: "Here's what I found." };
    });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("some value");

    await handleDeepgramMessage(
      resultsMessage("check a couple things then tell me", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    // Exactly two speakStreamed calls: the ack (once, not once per step)
    // and the real final answer — never a third for the second continuing
    // step, which would race the ack's own in-flight Speak connection use.
    expect(speakStreamed).toHaveBeenCalledTimes(2);
    // The exact rotating phrase doesn't matter, only that the FIRST call is
    // clearly an acknowledgment, not the real answer — and the SECOND call
    // is the genuine final text.
    expect(typeof speakStreamed.mock.calls[0][0]).toBe("string");
    expect(speakStreamed.mock.calls[0][0]).not.toBe("Here's what I found.");
    expect(speakStreamed).toHaveBeenNthCalledWith(2, "Here's what I found.");
  });

  it("Talker ack: a single-step turn (terminal on the very first call) never speaks an ack — no added latency on the common case", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "Quick answer." });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(
      resultsMessage("simple question", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      speakStreamed,
      history,
      turnState,
      () => 0,
      neverCalledWaitForToolResult,
    );

    expect(speakStreamed).toHaveBeenCalledTimes(1);
    expect(speakStreamed).toHaveBeenCalledWith("Quick answer.");
  });

  it("agent loop: hitting the iteration cap with no terminal verb degrades honestly instead of hanging", async () => {
    const { client, sent } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "read", target: "archive-btn" });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("some value");

    await handleDeepgramMessage(
      resultsMessage("keep checking something", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    // Never loops unboundedly even though the model never terminates.
    expect(respond.mock.calls.length).toBeLessThanOrEqual(6);
    expect(speakStreamed).toHaveBeenCalledWith(expect.stringContaining("wasn't able to finish"));
  });
});

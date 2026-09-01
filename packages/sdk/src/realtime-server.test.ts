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

const getContext = () => ({ route: "/", visible: [] as string[] });

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

    await handleDeepgramMessage(resultsMessage("hello", { isFinal: true, speechFinal: false }), client, deps, getContext, async () => {}, history, turnState, () => 0);
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

    await handleDeepgramMessage(resultsMessage("are you there", { isFinal: true, speechFinal: false }), client, deps, getContext, async () => {}, history, turnState, () => 0);
    expect(respond).not.toHaveBeenCalled();

    await handleDeepgramMessage(JSON.stringify({ type: "UtteranceEnd" }), client, deps, getContext, async () => {}, history, turnState, () => 0);
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
    );

    expect(sent.some((m: any) => m.type === "verb")).toBe(false);
    expect(speakStreamed).not.toHaveBeenCalled();
    // The user's own speech was still transcribed and shown — only the
    // (now-superseded) response is dropped.
    expect(sent.some((m: any) => m.type === "final")).toBe(true);
  });
});

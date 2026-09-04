import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { HistoryTurn, Manifest } from "@cairnvibe/core";
import type { StreamingTextLLM, VerbLLM } from "./server";
import { createBargeInConfirmation, formatRememberedFacts, handleDeepgramMessage, seedHistoryFromMemory, type ConnectionDeps } from "./realtime-server";
import type { MemoryTurnRecord } from "./memory-sqlite";

function fakeSpeakerLLM(respondStreamed: StreamingTextLLM["respondStreamed"]): StreamingTextLLM {
  return { respondStreamed };
}

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

function fakeMemoryStore() {
  return {
    rememberFact: vi.fn(),
    recallFact: vi.fn().mockReturnValue(null),
    recallFacts: vi.fn().mockReturnValue({}),
    recordTurn: vi.fn(),
    recentTurns: vi.fn().mockReturnValue([]),
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

// Phase 2 step 2 — the timer state machine behind confirm-or-reverse
// barge-in, extracted specifically so it could be tested in isolation
// with real fake timers, rather than left buried inside
// handleConnection's own closure where nothing about it was reachable.
// Phase 5 — the pure transformation behind seeding a fresh connection's
// starting history from real cross-session memory.
describe("seedHistoryFromMemory", () => {
  it("puts prior turns from memory first, oldest overall, ahead of any already-accumulated in-connection history", () => {
    const priorTurns: MemoryTurnRecord[] = [
      { role: "user", content: "archive my old invoices", createdAt: "t1" },
      { role: "assistant", content: "done, archived 3", createdAt: "t2" },
    ];
    const existing = [{ role: "user" as const, text: "what's this page for" }, { role: "assistant" as const, text: "it's the invoices page" }];

    const result = seedHistoryFromMemory(existing, priorTurns, 10);

    expect(result).toEqual([
      { role: "user", text: "archive my old invoices" },
      { role: "assistant", text: "done, archived 3" },
      { role: "user", text: "what's this page for" },
      { role: "assistant", text: "it's the invoices page" },
    ]);
  });

  it("caps to maxTurns, keeping the MOST RECENT turns overall — never silently unbounded", () => {
    const priorTurns: MemoryTurnRecord[] = Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, content: `prior ${i}`, createdAt: `t${i}` }));
    const result = seedHistoryFromMemory([], priorTurns, 4);
    expect(result.map((t) => t.text)).toEqual(["prior 2", "prior 3", "prior 4", "prior 5"]);
  });

  it("with no prior turns at all, returns the existing history unchanged", () => {
    const existing = [{ role: "user" as const, text: "hi" }];
    expect(seedHistoryFromMemory(existing, [], 10)).toEqual(existing);
  });

  it("with no existing history and no prior turns, returns an empty array", () => {
    expect(seedHistoryFromMemory([], [], 10)).toEqual([]);
  });
});

// Phase 5 step 3 — closes the loop step 2 opened: a remembered fact is
// only useful if a LATER turn's context actually contains it.
describe("formatRememberedFacts", () => {
  it("returns null for an empty fact set — nothing to say, not an empty string", () => {
    expect(formatRememberedFacts({})).toBeNull();
  });

  it("formats a single fact into a real, readable sentence", () => {
    expect(formatRememberedFacts({ preferredCurrency: "euros" })).toBe("Remembered from a previous conversation with this user: preferredCurrency — euros.");
  });

  it("formats multiple facts, each on its own key — value pair", () => {
    const result = formatRememberedFacts({ a: "1", b: "2" });
    expect(result).toContain("a — 1");
    expect(result).toContain("b — 2");
  });
});

describe("createBargeInConfirmation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onUnconfirmed after the window elapses with no confirm() call", () => {
    const confirmation = createBargeInConfirmation(600);
    const onUnconfirmed = vi.fn();

    confirmation.start(onUnconfirmed);
    vi.advanceTimersByTime(599);
    expect(onUnconfirmed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });

  it("confirm() before the window elapses cancels onUnconfirmed entirely — the real speech case", () => {
    const confirmation = createBargeInConfirmation(600);
    const onUnconfirmed = vi.fn();

    confirmation.start(onUnconfirmed);
    vi.advanceTimersByTime(300);
    confirmation.confirm();
    vi.advanceTimersByTime(1000);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  it("a second start() before the first resolves restarts the window instead of stacking two timers", () => {
    const confirmation = createBargeInConfirmation(600);
    const onUnconfirmed = vi.fn();

    confirmation.start(onUnconfirmed);
    vi.advanceTimersByTime(500);
    confirmation.start(onUnconfirmed); // a second barge-in before the first window elapsed
    vi.advanceTimersByTime(500); // 500ms since the restart — the ORIGINAL window (600ms from the first start) would have already fired if not properly reset
    expect(onUnconfirmed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100); // now 600ms since the restart
    expect(onUnconfirmed).toHaveBeenCalledTimes(1);
  });

  it("cancel() before the window elapses stops it — the connection-teardown case", () => {
    const confirmation = createBargeInConfirmation(600);
    const onUnconfirmed = vi.fn();

    confirmation.start(onUnconfirmed);
    confirmation.cancel();
    vi.advanceTimersByTime(1000);
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  it("confirm() with no pending window is a safe no-op", () => {
    const confirmation = createBargeInConfirmation(600);
    expect(() => confirmation.confirm()).not.toThrow();
  });
});

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

  // Phase 5 — recordMemoryTurn is called with the same real (role, text)
  // pairs history.push already records, right alongside it.
  it("Phase 5: recordMemoryTurn is called with the real user question and the real assistant answer for a terminal turn", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "hi there" });
    const deps = fakeDeps(respond);
    const recordMemoryTurn = vi.fn();

    await handleDeepgramMessage(
      resultsMessage("hello", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      undefined,
      recordMemoryTurn,
    );

    expect(recordMemoryTurn).toHaveBeenCalledWith("user", "hello");
    expect(recordMemoryTurn).toHaveBeenCalledWith("assistant", "hi there");
  });

  it("Phase 5: omitting recordMemoryTurn entirely is a safe no-op — every existing call site keeps working unchanged", async () => {
    const { client } = fakeClient();
    const deps = fakeDeps(vi.fn().mockResolvedValue({ verb: "explain", text: "ok" }));

    await expect(
      handleDeepgramMessage(resultsMessage("hello", { isFinal: true, speechFinal: true }), client, deps, getContext, async () => {}, [], { buffer: "" }, () => 0, neverCalledWaitForToolResult),
    ).resolves.not.toThrow();
  });

  // Phase 5 step 2 — explicit fact-remembering, handled entirely
  // server-side via a synthetic call_tool the client never sees.
  it("Phase 5 step 2: a remember_fact call_tool is handled server-side — writes to memory, never reaches the client as a verb, never awaits the client's own tool round trip", async () => {
    const { client, sent } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "call_tool", name: "remember_fact", args: { key: "preferredUnits", value: "metric" } } : { verb: "explain", text: "Got it, remembered." };
    });
    const deps = fakeDeps(respond);
    const memory = fakeMemoryStore();
    deps.memory = memory;
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(
      resultsMessage("remember I prefer metric units", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      history,
      turnState,
      () => 0,
      neverCalledWaitForToolResult, // if this were ever called, it would throw — proving the client round trip is genuinely skipped
      undefined,
      undefined,
      () => "user-1",
    );

    expect(memory.rememberFact).toHaveBeenCalledWith("user-1", "preferredUnits", "metric");
    expect(respond).toHaveBeenCalledTimes(2); // resolveVerb called again after the in-process "tool result", same as any other continuing step
    const verbMessages = sent.filter((m: any) => m.type === "verb");
    expect(verbMessages.every((m: any) => !(m.verb.verb === "call_tool" && m.verb.name === "remember_fact"))).toBe(true);
  });

  it("Phase 5 step 2: remember_fact is offered to the model only when memory AND a scopeId are both present", async () => {
    const { client } = fakeClient();
    let seenWebMcpTools: any;
    const respond = vi.fn().mockImplementation(async (_systemPrompt: string, userMessage: string) => {
      seenWebMcpTools = JSON.parse(userMessage).webMcpTools;
      return { verb: "explain", text: "ok" };
    });
    const deps = fakeDeps(respond);
    deps.memory = fakeMemoryStore();

    await handleDeepgramMessage(
      resultsMessage("hi", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      undefined,
      undefined,
      () => "user-1",
    );

    expect(seenWebMcpTools.some((t: any) => t.name === "remember_fact")).toBe(true);
  });

  it("Phase 5 step 2: remember_fact is NOT offered when memory is configured but this connection has no scopeId yet", async () => {
    const { client } = fakeClient();
    let seenWebMcpTools: any;
    const respond = vi.fn().mockImplementation(async (_systemPrompt: string, userMessage: string) => {
      seenWebMcpTools = JSON.parse(userMessage).webMcpTools;
      return { verb: "explain", text: "ok" };
    });
    const deps = fakeDeps(respond);
    deps.memory = fakeMemoryStore();

    await handleDeepgramMessage(
      resultsMessage("hi", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      undefined,
      undefined,
      () => null, // no scopeId for this connection
    );

    expect(seenWebMcpTools.some((t: any) => t.name === "remember_fact")).toBe(false);
  });

  it("Phase 5 step 2: with no key/value in args, remembers nothing and returns an honest observation instead of crashing", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "call_tool", name: "remember_fact", args: {} } : { verb: "explain", text: "done" };
    });
    const deps = fakeDeps(respond);
    const memory = fakeMemoryStore();
    deps.memory = memory;

    await handleDeepgramMessage(
      resultsMessage("remember something", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      undefined,
      undefined,
      () => "user-1",
    );

    expect(memory.rememberFact).not.toHaveBeenCalled();
  });

  // Phase 2 step 2 — onRealTranscript is the confirmation signal
  // triggerServerBargeIn's grace window waits for.
  it("Phase 2 step 2: onRealTranscript fires on a non-final (interim) transcript — the fastest possible confirmation, before speech_final ever arrives", async () => {
    const { client } = fakeClient();
    const deps = fakeDeps(vi.fn());
    const onRealTranscript = vi.fn();

    await handleDeepgramMessage(
      resultsMessage("hel", { isFinal: false }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      onRealTranscript,
    );

    expect(onRealTranscript).toHaveBeenCalledTimes(1);
  });

  it("Phase 2 step 2: onRealTranscript never fires for a message with no real transcript content", async () => {
    const { client } = fakeClient();
    const deps = fakeDeps(vi.fn());
    const onRealTranscript = vi.fn();

    await handleDeepgramMessage(
      JSON.stringify({ type: "Results", is_final: false, channel: { alternatives: [{ transcript: "" }] } }),
      client,
      deps,
      getContext,
      async () => {},
      [],
      { buffer: "" },
      () => 0,
      neverCalledWaitForToolResult,
      onRealTranscript,
    );

    expect(onRealTranscript).not.toHaveBeenCalled();
  });

  it("Phase 2 step 2: omitting onRealTranscript entirely is a safe no-op — every existing call site keeps working unchanged", async () => {
    const { client } = fakeClient();
    const deps = fakeDeps(vi.fn());

    await expect(
      handleDeepgramMessage(resultsMessage("hello", { isFinal: false }), client, deps, getContext, async () => {}, [], { buffer: "" }, () => 0, neverCalledWaitForToolResult),
    ).resolves.not.toThrow();
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

  const getContextWithTwoArchiveBtns = () => ({
    route: "/",
    visible: [] as string[],
    liveElements: [
      { id: "archive-btn", role: "button", label: "Archive" },
      { id: "archive-btn-2", role: "button", label: "Archive" },
    ],
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

  it("agent loop: batch is treated as a continuing verb too, generically — no special-casing needed for the loop to handle it", async () => {
    const { client, sent } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async (_systemPrompt: string, userMessage: string) => {
      call++;
      if (call === 1) {
        return {
          verb: "batch",
          actions: [
            { verb: "read", target: "archive-btn" },
            { verb: "click", target: "archive-btn" },
          ],
        };
      }
      const parsed = JSON.parse(userMessage);
      expect(parsed.history.at(-1).text).toContain("Result: batch done");
      return { verb: "explain", text: "Done, I archived it." };
    });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("batch done");

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
    const verbMessages = sent.filter((m: any) => m.type === "verb") as any[];
    expect(verbMessages[0].verb.verb).toBe("batch");
    expect(speakStreamed).toHaveBeenCalledWith("Done, I archived it.");
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

  it("Phase 2 step 3: the ack phrase's actual text is sent as a real 'ack' message — the only way its content is otherwise visible in the wire protocol", async () => {
    const { client, sent } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "read", target: "archive-btn" } : { verb: "explain", text: "Here's what I found." };
    });
    const deps = fakeDeps(respond);
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("some value");

    await handleDeepgramMessage(
      resultsMessage("check something then tell me", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    const ackMessages = sent.filter((m: any) => m.type === "ack") as any[];
    expect(ackMessages).toHaveLength(1);
    expect(typeof ackMessages[0].text).toBe("string");
    expect(ackMessages[0].text.length).toBeGreaterThan(0);
    // The ack text sent over the wire is the SAME text actually spoken —
    // never two different things.
    expect(speakStreamed.mock.calls[0][0]).toBe(ackMessages[0].text);
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

  // Phase 2 step 1 — the speculative Speaker call. See DEVELOPMENT.md for
  // the real, live-spiked reason this exists (a forced tool call never
  // streams at the field level on Groq; a plain, unforced call does and
  // typically finishes faster).
  it("Phase 2 step 1: a single-step terminal turn speaks the Speaker call's faster answer instead of the structured call's own text", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "Structured call's own slower answer." });
    const deps = fakeDeps(respond);
    deps.speakerLLM = fakeSpeakerLLM(async () => "The Speaker call's faster, genuinely streamed answer.");
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
    expect(speakStreamed).toHaveBeenCalledWith("The Speaker call's faster, genuinely streamed answer.");
  });

  it("Phase 2 step 1: falls back to the structured call's own text when the Speaker call returns nothing usable (empty string)", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "Structured call's own answer." });
    const deps = fakeDeps(respond);
    deps.speakerLLM = fakeSpeakerLLM(async () => "   "); // whitespace-only — treated as nothing usable
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

    expect(speakStreamed).toHaveBeenCalledWith("Structured call's own answer.");
  });

  it("Phase 2 step 1: falls back to the structured call's own text when the Speaker call itself throws — never breaks the turn", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "Structured call's own answer." });
    const deps = fakeDeps(respond);
    deps.speakerLLM = fakeSpeakerLLM(async () => {
      throw new Error("speaker provider network blip");
    });
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await expect(
      handleDeepgramMessage(
        resultsMessage("simple question", { isFinal: true, speechFinal: true }),
        client,
        deps,
        getContext,
        speakStreamed,
        history,
        turnState,
        () => 0,
        neverCalledWaitForToolResult,
      ),
    ).resolves.not.toThrow();

    expect(speakStreamed).toHaveBeenCalledWith("Structured call's own answer.");
  });

  it("Phase 2 step 1: a 'tour' terminal verb never uses the Speaker call — its own per-step texts don't map onto one streamed answer", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "tour", steps: [{ text: "Step one." }, { text: "Step two." }] });
    const deps = fakeDeps(respond);
    let speakerCalled = false;
    deps.speakerLLM = fakeSpeakerLLM(async () => {
      speakerCalled = true;
      return "This should never be spoken for a tour.";
    });
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };

    await handleDeepgramMessage(
      resultsMessage("give me a tour", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContext,
      speakStreamed,
      history,
      turnState,
      () => 0,
      neverCalledWaitForToolResult,
    );

    // tour has no top-level "text" at all, so speakStreamed is never
    // called directly from the terminal-outcome path either way — the
    // real assertion here is that the speculative speaker answer was
    // never the thing spoken (it wasn't spoken at all, by design).
    expect(speakStreamed).not.toHaveBeenCalledWith("This should never be spoken for a tour.");
  });

  it("Phase 2 step 1: a multi-step turn never uses turn-0's speculative speaker answer — it would be stale relative to what actually happened", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "read", target: "archive-btn" } : { verb: "explain", text: "The real, final answer after checking." };
    });
    const deps = fakeDeps(respond);
    deps.speakerLLM = fakeSpeakerLLM(async () => "Turn-0's stale speculative guess.");
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("some value");

    await handleDeepgramMessage(
      resultsMessage("check something then tell me", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    expect(speakStreamed).toHaveBeenCalledWith("The real, final answer after checking.");
    expect(speakStreamed).not.toHaveBeenCalledWith("Turn-0's stale speculative guess.");
  });

  it("Phase 2 step 1: no speakerLLM configured means the turn behaves exactly as before — the structured call's own text, unchanged", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "explain", text: "Only the structured answer exists." });
    const deps = fakeDeps(respond); // deps.speakerLLM left unset
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

    expect(speakStreamed).toHaveBeenCalledWith("Only the structured answer exists.");
  });

  it("Phase 3 step 2: a real Planner call fires exactly once on the first continuing step, fire-and-forget — never delays or changes the turn's real outcome", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) return { verb: "read", target: "archive-btn" };
      return { verb: "explain", text: "Here's what I found." };
    });
    const deps = fakeDeps(respond);
    let planCalls = 0;
    let resolvePlanCall: () => void = () => {};
    const planStarted = new Promise<void>((resolve) => {
      resolvePlanCall = resolve;
    });
    deps.planLLM = {
      respond: async () => {
        planCalls++;
        resolvePlanCall();
        // Deliberately slow — proves the turn doesn't wait for this.
        await new Promise((r) => setTimeout(r, 50));
        return { goal: "check a couple things then tell me", facts: [], tasks: [{ id: "t1", description: "check things", doneContract: "checked" }] };
      },
    };
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("some value");

    const turnPromise = handleDeepgramMessage(
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

    await planStarted; // the Planner call has started — prove it started DURING the turn, not after
    await turnPromise;

    expect(planCalls).toBe(1);
    // The turn itself completed correctly, unaffected by the still-slower Planner call.
    expect(speakStreamed).toHaveBeenNthCalledWith(2, "Here's what I found.");
  });

  it("Phase 4 step 3: the real Planner call carries the connection's real manifest — page directory and data-shape names, not just the bare transcript", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) return { verb: "read", target: "archive-btn" };
      return { verb: "explain", text: "Here's what I found." };
    });
    const deps = fakeDeps(respond);
    deps.manifest = {
      version: "1",
      commit: "test",
      generatedAt: new Date().toISOString(),
      pages: [
        {
          id: "invoices",
          route: "/invoices",
          file: "app/invoices/page.tsx",
          title: "Invoices",
          purpose: "Shows every invoice you've sent.",
          whenToUse: "Come here to check payments.",
          confidence: 0.9,
          elements: [],
          dataShapes: [{ name: "Invoice", source: "lib/invoices.ts", fields: [{ name: "status", type: '"Paid" | "Overdue"', optional: false }] }],
        },
      ],
      dead: [],
      conflicts: [],
    };
    let seenPlannerUserMessage = "";
    deps.planLLM = {
      respond: async (_systemPrompt, userMessage) => {
        seenPlannerUserMessage = userMessage;
        return { goal: "check a couple things then tell me", facts: [], tasks: [{ id: "t1", description: "check things", doneContract: "checked" }] };
      },
    };
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

    const parsed = JSON.parse(seenPlannerUserMessage);
    expect(parsed.pages).toContain("/invoices: Shows every invoice you've sent.");
    expect(parsed.pages).toContain("(data: Invoice)");
  });

  it("Phase 4 step 4: the real Planner call also carries the connection's registered actions, with real descriptions where configured", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      if (call <= 2) return { verb: "read", target: "archive-btn" };
      return { verb: "explain", text: "Here's what I found." };
    });
    const deps = fakeDeps(respond);
    deps.registeredActions = ["archiveInvoice"];
    deps.actionDescriptions = { archiveInvoice: "Archives the invoice; cannot be undone." };
    let seenPlannerUserMessage = "";
    deps.planLLM = {
      respond: async (_systemPrompt, userMessage) => {
        seenPlannerUserMessage = userMessage;
        return { goal: "archive overdue invoices", facts: [], tasks: [{ id: "t1", description: "archive things", doneContract: "archived" }] };
      },
    };
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

    const parsed = JSON.parse(seenPlannerUserMessage);
    expect(parsed.actions).toBe("archiveInvoice (Archives the invoice; cannot be undone.)");
  });

  it("Phase 3 step 2: no planLLM configured means no Planner call at all — the observability wiring is opt-in, not required", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "read", target: "archive-btn" } : { verb: "explain", text: "done" };
    });
    const deps = fakeDeps(respond); // no planLLM set
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("v");

    await expect(
      handleDeepgramMessage(
        resultsMessage("check something", { isFinal: true, speechFinal: true }),
        client,
        deps,
        getContextWithArchiveBtn,
        speakStreamed,
        history,
        turnState,
        () => 0,
        waitForToolResult,
      ),
    ).resolves.not.toThrow();
    expect(speakStreamed).toHaveBeenCalledWith("done");
  });

  it("Phase 3 step 3, real bug fix: a task_complete Critic verdict ends the turn right after the batch that actually finished it — no second respond() call, unlike the diagnosed bug where the model kept looping", async () => {
    const { client, sent } = fakeClient();
    const respond = vi.fn().mockResolvedValue({
      verb: "batch",
      actions: [{ verb: "click", target: "archive-btn" }, { verb: "click", target: "archive-btn-2" }],
    });
    const deps = fakeDeps(respond);
    deps.planLLM = { respond: async () => ({ goal: "archive both overdue invoices", facts: [], tasks: [{ id: "t1", description: "Archive both overdue invoices", doneContract: "Both invoices show status Archived" }] }) };
    deps.criticLLM = { respond: async () => ({ verdict: "task_complete", reasoning: "Both invoices now show status Archived, matching the doneContract." }) };
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("Both archived");

    await handleDeepgramMessage(
      resultsMessage("archive both overdue invoices", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithTwoArchiveBtns,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    // The real bug this fixes: respond() (the model) is called exactly
    // ONCE — the batch — never a second time "hoping it notices" the
    // real state already satisfies the goal. The Critic's own real
    // reasoning is what gets spoken and committed to history instead.
    expect(respond).toHaveBeenCalledTimes(1);
    expect(speakStreamed).toHaveBeenCalledWith("Both invoices now show status Archived, matching the doneContract.");
    expect(history).toEqual([
      { role: "user", text: "archive both overdue invoices" },
      { role: "assistant", text: "Both invoices now show status Archived, matching the doneContract." },
    ]);
    const verbMessages = sent.filter((m: any) => m.type === "verb");
    expect(verbMessages).toHaveLength(1); // only the batch itself was ever sent — no synthetic second verb message
  });

  it("Phase 3 step 3: a give_up Critic verdict ends the turn early with its own real reasoning, distinct from the generic iteration-cap message", async () => {
    const { client } = fakeClient();
    const respond = vi.fn().mockResolvedValue({ verb: "click", target: "archive-btn" });
    const deps = fakeDeps(respond);
    deps.planLLM = { respond: async () => ({ goal: "archive the invoice", facts: [], tasks: [{ id: "t1", description: "Archive the invoice", doneContract: "The invoice shows status Archived" }] }) };
    deps.criticLLM = { respond: async () => ({ verdict: "give_up", reasoning: "The click has no visible effect after repeated attempts — the button may be disabled." }) };
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("nothing changed");

    await handleDeepgramMessage(
      resultsMessage("archive the invoice", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithArchiveBtn,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    expect(respond).toHaveBeenCalledTimes(1);
    expect(speakStreamed).toHaveBeenCalledWith("The click has no visible effect after repeated attempts — the button may be disabled.");
  });

  it("Phase 3 step 3: a multi-task plan advances to the next task on task_complete and keeps looping instead of ending the turn early", async () => {
    const { client } = fakeClient();
    let call = 0;
    const respond = vi.fn().mockImplementation(async () => {
      call++;
      return call === 1 ? { verb: "click", target: "archive-btn" } : { verb: "click", target: "archive-btn-2" };
    });
    const deps = fakeDeps(respond);
    deps.planLLM = {
      respond: async () => ({
        goal: "archive both invoices, one at a time",
        facts: [],
        tasks: [
          { id: "t1", description: "Archive the first invoice", doneContract: "The first invoice shows status Archived" },
          { id: "t2", description: "Archive the second invoice", doneContract: "The second invoice shows status Archived" },
        ],
      }),
    };
    let criticCall = 0;
    deps.criticLLM = {
      respond: async () => {
        criticCall++;
        // First task's own click completes it; the second doesn't (loop
        // hits the iteration cap deliberately, to keep this test focused
        // on proving advancement — not full completion).
        return criticCall === 1 ? { verdict: "task_complete", reasoning: "First invoice archived." } : { verdict: "continue", reasoning: "Still working on the second." };
      },
    };
    const speakStreamed = vi.fn().mockResolvedValue(undefined);
    const history: HistoryTurn[] = [];
    const turnState = { buffer: "" };
    const waitForToolResult = vi.fn().mockResolvedValue("archived");

    await handleDeepgramMessage(
      resultsMessage("archive both invoices, one at a time", { isFinal: true, speechFinal: true }),
      client,
      deps,
      getContextWithTwoArchiveBtns,
      speakStreamed,
      history,
      turnState,
      () => 0,
      waitForToolResult,
    );

    // Real proof of advancement: the model was asked again after the
    // first task_complete (not ended there), and the Critic itself was
    // consulted more than once — a real multi-task turn, not a single
    // task ending prematurely.
    expect(respond.mock.calls.length).toBeGreaterThan(1);
    expect(criticCall).toBeGreaterThan(1);
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

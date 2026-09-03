import { describe, expect, it } from "vitest";
import { driveAgentLoop, summarizeVerbForHistory } from "./agent-loop";
import type { HistoryTurn, VerbResponse } from "@cairnvibe/core";

describe("driveAgentLoop", () => {
  it("a single-shot terminal verb on the very first call ends the loop immediately, no executeStep call", async () => {
    const finalVerb: VerbResponse = { verb: "explain", text: "Quick answer." };
    let executeStepCalls = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async () => finalVerb,
      executeStep: async () => {
        executeStepCalls++;
        return "unused";
      },
    });
    expect(result).toEqual({ outcome: "terminal", finalVerb, workingHistory: [] });
    expect(executeStepCalls).toBe(0);
  });

  it("a continuing verb executes for real, folds its observation into working history, then asks again", async () => {
    let call = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async (loopHistory) => {
        call++;
        if (call === 1) return { verb: "click", target: "archive-btn" };
        // Second call — the real click result should already be folded in.
        expect(loopHistory.at(-1)?.text).toContain("Result: Archived");
        return { verb: "explain", text: "Done, I archived it." };
      },
      executeStep: async () => "Archived",
    });
    expect(result.outcome).toBe("terminal");
    if (result.outcome === "terminal") expect(result.finalVerb).toEqual({ verb: "explain", text: "Done, I archived it." });
    expect(call).toBe(2);
  });

  it("folds 'no result' when executeStep returns null/undefined — matches both original drivers' own fallback text", async () => {
    let call = 0;
    await driveAgentLoop([], {
      getNextStep: async (loopHistory) => {
        call++;
        if (call === 1) return { verb: "read", target: "x" };
        expect(loopHistory.at(-1)?.text).toContain("Result: no result");
        return { verb: "explain", text: "done" };
      },
      executeStep: async () => undefined,
    });
    expect(call).toBe(2);
  });

  it("a null getNextStep result (a raw response that failed schema validation) ends the loop with outcome 'unparseable'", async () => {
    const result = await driveAgentLoop([], {
      getNextStep: async () => null,
      executeStep: async () => "unused",
    });
    expect(result.outcome).toBe("unparseable");
  });

  it("hitting maxIterations with no terminal verb ends with outcome 'gave-up', never looping unboundedly", async () => {
    let calls = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async () => {
        calls++;
        return { verb: "read", target: "x" };
      },
      executeStep: async () => "some value",
      maxIterations: 3,
    });
    expect(result.outcome).toBe("gave-up");
    expect(calls).toBe(3);
  });

  it("defaults maxIterations to 6, matching both original drivers' hard cap", async () => {
    let calls = 0;
    await driveAgentLoop([], {
      getNextStep: async () => {
        calls++;
        return { verb: "read", target: "x" };
      },
      executeStep: async () => "v",
    });
    expect(calls).toBe(6);
  });

  it("onStep can abort the loop before the terminal/continuing branch runs — no executeStep call, outcome 'aborted'", async () => {
    let executeStepCalls = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async () => ({ verb: "click", target: "x" }),
      onStep: () => true,
      executeStep: async () => {
        executeStepCalls++;
        return "unused";
      },
    });
    expect(result.outcome).toBe("aborted");
    expect(executeStepCalls).toBe(0);
  });

  it("onStepResult can abort the loop after executeStep resolves, discarding that step's observation", async () => {
    let getNextStepCalls = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async () => {
        getNextStepCalls++;
        return { verb: "click", target: "x" };
      },
      executeStep: async () => "real result",
      onStepResult: () => true,
    });
    expect(result.outcome).toBe("aborted");
    // Never asked a second time after the abort.
    expect(getNextStepCalls).toBe(1);
  });

  it("onStep tells the caller whether this step is terminal, matching TERMINAL_VERBS", async () => {
    const seen: { verb: string; terminal: boolean }[] = [];
    let call = 0;
    await driveAgentLoop([], {
      getNextStep: async () => {
        call++;
        return call === 1 ? { verb: "click", target: "x" } : { verb: "explain", text: "done" };
      },
      onStep: (event) => {
        seen.push({ verb: event.verb.verb, terminal: event.terminal });
        return false;
      },
      executeStep: async () => "v",
    });
    expect(seen).toEqual([
      { verb: "click", terminal: false },
      { verb: "explain", terminal: true },
    ]);
  });

  it("working history is capped at MAX_HISTORY_TURNS entries, oldest dropped first", async () => {
    let call = 0;
    const result = await driveAgentLoop([], {
      getNextStep: async () => {
        call++;
        return call <= 10 ? { verb: "read", target: `t${call}` } : { verb: "explain", text: "done" };
      },
      executeStep: async () => "v",
      maxIterations: 11,
    });
    expect(result.workingHistory.length).toBeLessThanOrEqual(8);
  });

  it("real seed initialHistory is preserved and built on, not discarded", async () => {
    const seed: HistoryTurn[] = [
      { role: "user", text: "earlier question" },
      { role: "assistant", text: "earlier answer" },
    ];
    const result = await driveAgentLoop(seed, {
      getNextStep: async (loopHistory) => {
        expect(loopHistory).toEqual(seed);
        return { verb: "explain", text: "new answer" };
      },
      executeStep: async () => "unused",
    });
    expect(result.workingHistory).toEqual(seed);
  });
});

describe("summarizeVerbForHistory", () => {
  it("prefers real spoken text when present, regardless of verb", () => {
    expect(summarizeVerbForHistory({ verb: "explain", text: "the real answer" })).toBe("the real answer");
  });

  it("falls back to a real description per verb when there's no text", () => {
    expect(summarizeVerbForHistory({ verb: "click", target: "archive-btn" })).toBe("(clicked archive-btn)");
    expect(summarizeVerbForHistory({ verb: "navigate", route: "/settings" })).toBe("(navigated to /settings)");
    expect(
      summarizeVerbForHistory({ verb: "batch", actions: [{ verb: "click", target: "a" }, { verb: "read", target: "b" }] }),
    ).toBe("(2 steps: click, read)");
  });
});

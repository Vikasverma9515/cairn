import { describe, expect, it } from "vitest";
import { driveAgentLoop, looksMultiStep, summarizeVerbForHistory } from "./agent-loop";
import type { AgentEvent, CriticVerdict, HistoryTurn, VerbResponse } from "@cairnvibe/core";

describe("looksMultiStep", () => {
  it("flags real compound-goal sequencing language", () => {
    expect(looksMultiStep("check the price and then buy it")).toBe(true);
    expect(looksMultiStep("Find the invoice, then archive it.")).toBe(true);
    expect(looksMultiStep("Once you find it, open the detail view.")).toBe(true);
    expect(looksMultiStep("First check the price, then decide.")).toBe(true);
  });

  it("is conservative on a plain, single-step question — a false negative just falls back to the existing lazy gate, never a wrong answer", () => {
    expect(looksMultiStep("what does this button do")).toBe(false);
    expect(looksMultiStep("archive Acme Co.")).toBe(false);
    expect(looksMultiStep("show me clients and invoices")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(looksMultiStep("CHECK THE PRICE AND THEN BUY IT")).toBe(true);
  });
});

function verdict(kind: CriticVerdict["verdict"], reasoning = "test"): CriticVerdict {
  return { verdict: kind, reasoning };
}

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

  // Real, live-reported gap this closes: "buy earbuds" resolved to a plain
  // navigate, which used to end the turn the instant it arrived at the
  // shop — the user had to manually ask "did you find anything" for every
  // further step. See isTerminalVerb in @cairnvibe/core.
  it("a navigate marked continueAfter is NOT terminal — the loop executes it as a real step and asks again, instead of ending the turn the instant it arrives", async () => {
    let call = 0;
    const seen: { verb: string; terminal: boolean }[] = [];
    const result = await driveAgentLoop([], {
      getNextStep: async (loopHistory) => {
        call++;
        if (call === 1) return { verb: "navigate", route: "/shop", continueAfter: true };
        // Second call — the real navigation's own observation should
        // already be folded into history, same as any other continuing step.
        expect(loopHistory.at(-1)?.text).toContain("Result: Navigated to /shop.");
        return { verb: "explain", text: "I searched the shop and found earbuds." };
      },
      onStep: (event) => {
        seen.push({ verb: event.verb.verb, terminal: event.terminal });
        return false;
      },
      executeStep: async () => "Navigated to /shop.",
    });
    expect(seen).toEqual([
      { verb: "navigate", terminal: false },
      { verb: "explain", terminal: true },
    ]);
    expect(call).toBe(2);
    expect(result.outcome).toBe("terminal");
    if (result.outcome === "terminal") expect(result.finalVerb).toEqual({ verb: "explain", text: "I searched the shop and found earbuds." });
  });

  it("a plain navigate (no continueAfter) stays terminal — the common 'take me to X' case pays zero extra latency, unchanged", async () => {
    let executeStepCalls = 0;
    const finalVerb: VerbResponse = { verb: "navigate", route: "/invoices" };
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

  describe("runCritic (Phase 3 step 3 — the actual bug fix)", () => {
    it("real bug this exists to fix: a task_complete verdict ends the loop right after the FIRST continuing step, even though the model's own verb was never terminal — no second getNextStep call, unlike today's blind-continue behavior", async () => {
      let getNextStepCalls = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          getNextStepCalls++;
          return { verb: "batch", actions: [{ verb: "click", target: "a" }, { verb: "click", target: "b" }] };
        },
        executeStep: async () => "both archived",
        runCritic: async () => verdict("task_complete", "The real state now matches the task's doneContract."),
      });
      expect(result.outcome).toBe("critic-complete");
      if (result.outcome === "critic-complete") expect(result.verdict.reasoning).toContain("doneContract");
      expect(getNextStepCalls).toBe(1);
    });

    it("a give_up verdict ends the loop immediately too, distinct from hitting the iteration cap", async () => {
      let getNextStepCalls = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          getNextStepCalls++;
          return { verb: "click", target: "x" };
        },
        executeStep: async () => "nothing changed",
        runCritic: async () => verdict("give_up", "Stuck — the click has no visible effect."),
      });
      expect(result.outcome).toBe("critic-give-up");
      expect(getNextStepCalls).toBe(1);
    });

    it("a continue verdict keeps the loop going exactly as if runCritic were absent", async () => {
      let call = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "x" } : { verb: "explain", text: "done for real" };
        },
        executeStep: async () => "step 1 done",
        runCritic: async () => verdict("continue", "Real progress, but the doneContract isn't satisfied yet."),
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(2);
    });

    it("a null/undefined verdict (the caller chose not to run the Critic this step) behaves exactly like continue", async () => {
      let call = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "x" } : { verb: "explain", text: "done" };
        },
        executeStep: async () => "v",
        runCritic: async () => undefined,
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(2);
    });

    it("a 'replan' verdict also keeps the loop going — driveAgentLoop itself has no concept of a Plan, it only sees stop-vs-continue; the caller's own runCritic closure is responsible for actually replanning before returning", async () => {
      let call = 0;
      const seenVerdicts: string[] = [];
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "wrong-element" } : { verb: "explain", text: "done after replanning" };
        },
        executeStep: async () => "nothing happened",
        runCritic: async () => {
          const v = verdict("replan", "Wrong element targeted — replanning.");
          seenVerdicts.push(v.verdict);
          return v; // driveAgentLoop treats a bare "replan" the same as "continue" — it never inspects verdict.verdict beyond task_complete/give_up
        },
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(2);
      expect(seenVerdicts).toEqual(["replan"]);
    });

    it("runCritic never fires for a terminal-on-first-call turn — nothing to critique when there was no continuing step at all", async () => {
      let criticCalls = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "explain", text: "Quick answer." }),
        executeStep: async () => "unused",
        runCritic: async () => {
          criticCalls++;
          return verdict("task_complete");
        },
      });
      expect(result.outcome).toBe("terminal");
      expect(criticCalls).toBe(0);
    });

    it("the working history already includes this step's real result by the time runCritic sees it", async () => {
      let seenObservationInCritic: string | null | undefined;
      await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "click", target: "x" }),
        executeStep: async () => "the real click result",
        runCritic: async (event) => {
          seenObservationInCritic = event.observation;
          return verdict("task_complete");
        },
      });
      expect(seenObservationInCritic).toBe("the real click result");
    });
  });

  describe("onEvent (Phase 3 step 5 — the Talker's event stream)", () => {
    it("emits a real 'act' event for a continuing step, then a real 'obs' event once its observation arrives — in that order", async () => {
      const events: AgentEvent[] = [];
      let call = 0;
      await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "archive-btn" } : { verb: "explain", text: "done" };
        },
        executeStep: async () => "Clicked it.",
        onEvent: (e) => events.push(e),
      });
      expect(events[0]).toMatchObject({ type: "act", verb: { verb: "click", target: "archive-btn" } });
      expect(events[1]).toMatchObject({ type: "obs", observation: "Clicked it.", ok: true });
      expect(events[2]).toMatchObject({ type: "act", verb: { verb: "explain", text: "done" } });
      // The terminal verb ends the loop right after its own "act" event — no "obs" follows it, since it's never executed as a step.
      expect(events).toHaveLength(3);
    });

    it("real 'ok: false' semantics: 'obs' still fires (a real observation arrived) even when executeStep returns null/undefined — 'ok' means 'a result arrived', not 'the underlying action succeeded'", async () => {
      const events: AgentEvent[] = [];
      let call = 0;
      await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "read", target: "x" } : { verb: "explain", text: "done" };
        },
        executeStep: async () => undefined,
        onEvent: (e) => events.push(e),
      });
      const obsEvent = events.find((e) => e.type === "obs");
      expect(obsEvent).toMatchObject({ type: "obs", observation: "no result", ok: false });
    });

    it("never emits 'act' for a step that onStep aborted — an aborted step never really happened", async () => {
      const events: AgentEvent[] = [];
      await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "click", target: "x" }),
        onStep: () => true,
        executeStep: async () => "unused",
        onEvent: (e) => events.push(e),
      });
      expect(events).toHaveLength(0);
    });

    it("never emits 'obs' for a step whose result onStepResult aborted — a discarded observation was never really folded in", async () => {
      const events: AgentEvent[] = [];
      await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "click", target: "x" }),
        executeStep: async () => "real result",
        onStepResult: () => true,
        onEvent: (e) => events.push(e),
      });
      expect(events).toEqual([{ type: "act", verb: { verb: "click", target: "x" }, at: expect.any(Number) }]);
    });

    it("a caller's own onStep/runCritic closures can emit their own 'inj'/'thk' events through the same shared callback — driveAgentLoop has no opinion on those, it just carries them through", async () => {
      const events: AgentEvent[] = [];
      // Mirrors the real shape a transport (e.g. realtime-server.ts) uses:
      // a single local emitEvent function, referenced directly by
      // onStep/runCritic AND passed as onEvent — not routed back through
      // deps itself, which has no sibling access between its own fields.
      const emitEvent = (e: AgentEvent) => events.push(e);
      let call = 0;
      await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "x" } : { verb: "explain", text: "done" };
        },
        onStep: ({ iteration, terminal }) => {
          if (!terminal && iteration === 0) emitEvent({ type: "inj", text: "Let me check that for you.", at: Date.now() });
          return false;
        },
        executeStep: async () => "v",
        runCritic: async () => {
          emitEvent({ type: "thk", text: "Real progress, not done yet.", at: Date.now() });
          return verdict("continue");
        },
        onEvent: emitEvent,
      });
      expect(events.some((e) => e.type === "inj" && e.text === "Let me check that for you.")).toBe(true);
      expect(events.some((e) => e.type === "thk" && e.text === "Real progress, not done yet.")).toBe(true);
    });
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

  it("describes drag/select/key the same real way as click/fill/read — Pillar 1's richer action vocabulary", () => {
    expect(summarizeVerbForHistory({ verb: "drag", target: "node-a", to: "node-b" })).toBe("(dragged node-a to node-b)");
    expect(summarizeVerbForHistory({ verb: "select", target: "status-dropdown", value: "Overdue" })).toBe('(selected "Overdue" in status-dropdown)');
    expect(summarizeVerbForHistory({ verb: "key", target: "search-box", key: "Enter" })).toBe("(pressed Enter on search-box)");
    expect(summarizeVerbForHistory({ verb: "key", key: "Escape" })).toBe("(pressed Escape)");
  });
});

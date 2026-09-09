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

  it("real, live-found gap this widening closes: a create/build goal described by what it should end up DOING, not by narrating its own steps, is just as multi-step as one with explicit sequencing words — missed entirely before this fix", () => {
    expect(looksMultiStep("I wanted to create an agent for the healthcare that could call the patient and check if they're okay")).toBe(true);
    expect(looksMultiStep("build me an agent that can answer billing questions")).toBe(true);
    expect(looksMultiStep("set up an assistant who should greet new patients")).toBe(true);
    // Still conservative on a genuinely single-step create — no "that/which/who can/could/should/would" clause describing further behavior.
    expect(looksMultiStep("create a new agent")).toBe(false);
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

  it("defaults maxIterations to 25 — real, live-found fix: a genuine ~20-step goal was hitting the old cap of 6 long before the Planner/Critic could actually finish it", async () => {
    let calls = 0;
    await driveAgentLoop([], {
      getNextStep: async () => {
        calls++;
        return { verb: "read", target: "x" };
      },
      executeStep: async () => "v",
    });
    expect(calls).toBe(25);
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

    it("a continue verdict keeps the loop going exactly as if runCritic were absent — for a CONTINUING step; the caller confirms the eventual terminal answer with task_complete once it's actually satisfied", async () => {
      let call = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return call === 1 ? { verb: "click", target: "x" } : { verb: "explain", text: "done for real" };
        },
        executeStep: async () => "step 1 done",
        runCritic: async ({ terminal }) => (terminal ? verdict("task_complete") : verdict("continue", "Real progress, but the doneContract isn't satisfied yet.")),
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(2);
    });

    it("real fix this whole block exists for: a terminal verb's OWN claim now gets critic-checked too — a rejected claim (continue) doesn't ship, it loops again with the rejection folded into history as real feedback", async () => {
      let call = 0;
      let criticCallsOnTerminal = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => {
          call++;
          return { verb: "explain", text: `Attempt ${call}: it's set up.` };
        },
        executeStep: async () => "unused",
        runCritic: async ({ terminal, verb }) => {
          expect(terminal).toBe(true); // every call here is a first-try terminal answer
          criticCallsOnTerminal++;
          if (call < 3) return verdict("continue", `Attempt ${call} doesn't actually satisfy the goal — ${JSON.stringify(verb)}`);
          return verdict("task_complete", "Now it genuinely matches the doneContract.");
        },
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(3);
      expect(criticCallsOnTerminal).toBe(3);
      if (result.outcome === "terminal") expect(result.finalVerb).toEqual({ verb: "explain", text: "Attempt 3: it's set up." });
      // The two rejected attempts are real, visible feedback in history — not silently discarded.
      expect(result.workingHistory.some((h) => h.text.includes("Not actually complete yet") && h.text.includes("Attempt 1"))).toBe(true);
    });

    it("a give_up verdict on a TERMINAL claim ends with critic-give-up, distinct from letting a wrong claim ship as 'terminal'", async () => {
      const result = await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "explain", text: "It's done." }),
        executeStep: async () => "unused",
        runCritic: async ({ terminal }) => (terminal ? verdict("give_up", "That claim doesn't hold up and nothing suggests it ever will.") : verdict("continue")),
      });
      expect(result.outcome).toBe("critic-give-up");
    });

    it("a null/undefined verdict on a terminal claim ships it unchecked — a caller's own deliberate choice not to check this particular answer (e.g. no Plan active for an ordinary one-turn question), zero regression from before this fix", async () => {
      const finalVerb: VerbResponse = { verb: "explain", text: "Hi, how can I help?" };
      const result = await driveAgentLoop([], {
        getNextStep: async () => finalVerb,
        executeStep: async () => "unused",
        runCritic: async () => undefined,
      });
      expect(result).toEqual({ outcome: "terminal", finalVerb, workingHistory: [] });
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
        runCritic: async ({ terminal }) => {
          const v = terminal ? verdict("task_complete") : verdict("replan", "Wrong element targeted — replanning.");
          seenVerdicts.push(v.verdict);
          return v; // driveAgentLoop treats a bare "replan" the same as "continue" — it never inspects verdict.verdict beyond task_complete/give_up
        },
      });
      expect(result.outcome).toBe("terminal");
      expect(call).toBe(2);
      expect(seenVerdicts).toEqual(["replan", "task_complete"]);
    });

    it("runCritic now DOES fire for a terminal-on-first-call turn — real fix for self-evaluation bias (2026 agent research: an agent's own unchecked claim of success is frequently wrong). Only skipped when a caller genuinely has nothing to check it against (see the null/undefined-verdict test above).", async () => {
      let criticCalls = 0;
      const result = await driveAgentLoop([], {
        getNextStep: async () => ({ verb: "explain", text: "Quick answer." }),
        executeStep: async () => "unused",
        runCritic: async ({ terminal }) => {
          expect(terminal).toBe(true);
          criticCalls++;
          return verdict("task_complete");
        },
      });
      expect(result.outcome).toBe("terminal");
      expect(criticCalls).toBe(1);
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
        runCritic: async ({ terminal }) => {
          emitEvent({ type: "thk", text: "Real progress, not done yet.", at: Date.now() });
          return terminal ? verdict("task_complete") : verdict("continue");
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

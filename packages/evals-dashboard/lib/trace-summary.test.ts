// Real, live-found bug this file guards against: copilotRoundTrips records
// every real HTTP round trip a turn makes — not just /api/copilot's own
// verb calls, but /api/copilot/plan and /api/copilot/critic too — and the
// first version of this summarizer had no idea those existed, so it
// painted every real Plan/Critic call red as "unparseable." Confirmed
// live against a real stored trial before this fix existed.
import { describe, expect, it } from "vitest";
import { summarizeRoundTrip } from "./trace-summary";

describe("summarizeRoundTrip", () => {
  it("classifies a real verb response and produces a readable headline", () => {
    const result = summarizeRoundTrip({ question: "archive it" }, { verb: "click", target: "archive-btn" });
    expect(result.kind).toBe("verb");
    expect(result.verb).toBe("click");
    expect(result.headline).toContain("clicked archive-btn");
    expect(result.question).toBe("archive it");
  });

  it("real bug this closes: a real Planner response ({tasks, goal}) is classified as 'plan', not 'unparseable' — it has no verb field at all", () => {
    const planResponse = {
      version: 1,
      goal: "Archive the invoice",
      tasks: [{ id: "t1", description: "Find and archive the invoice for Acme", status: "in_progress" }],
    };
    const result = summarizeRoundTrip({}, planResponse);
    expect(result.kind).toBe("plan");
    expect(result.verb).toBeNull();
    expect(result.headline).toContain("1 task");
    expect(result.headline).toContain("Find and archive the invoice for Acme");
  });

  it("real bug this closes: a real Critic verdict ({verdict, reasoning}) is classified as 'critic', not 'unparseable'", () => {
    const criticResponse = { verdict: "replan", reasoning: "The workflow was never saved." };
    const result = summarizeRoundTrip({}, criticResponse);
    expect(result.kind).toBe("critic");
    expect(result.headline).toContain("replan");
    expect(result.headline).toContain("The workflow was never saved.");
  });

  it("a genuinely empty or malformed response is still reported as unparseable — the real case, not every non-verb response", () => {
    expect(summarizeRoundTrip({}, null).kind).toBe("unparseable");
    expect(summarizeRoundTrip({}, { foo: "bar" }).kind).toBe("unparseable");
    expect(summarizeRoundTrip({}, "not an object").kind).toBe("unparseable");
  });

  it("a batch verb summarizes each of its real sub-actions, not just the count", () => {
    const result = summarizeRoundTrip(
      {},
      { verb: "batch", actions: [{ verb: "click", target: "a" }, { verb: "fill", target: "b", value: "x" }] },
    );
    expect(result.headline).toContain("clicked a");
    expect(result.headline).toContain('typed "x" into b');
  });

  it("explain, fill, and navigate each produce a real, specific headline", () => {
    expect(summarizeRoundTrip({}, { verb: "explain", text: "done" }).headline).toContain('explained: "done"');
    expect(summarizeRoundTrip({}, { verb: "fill", target: "email", value: "a@b.com" }).headline).toContain('typed "a@b.com" into email');
    expect(summarizeRoundTrip({}, { verb: "navigate", route: "/invoices" }).headline).toContain("navigated to /invoices");
  });

  it("the question is only attached from a real request body, and only when present", () => {
    expect(summarizeRoundTrip({ question: "hi" }, { verb: "explain", text: "hey" }).question).toBe("hi");
    expect(summarizeRoundTrip({}, { verb: "explain", text: "hey" }).question).toBeNull();
  });
});

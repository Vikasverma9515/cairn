import { describe, expect, it } from "vitest";
import { CriticVerdictSchema, PlanSchema, PlannerOutputSchema, ProgressLedgerSchema, TaskSchema } from "./index";

describe("plan.ts re-exported from index.ts", () => {
  it("real smoke test for the circular-import risk noted in plan.ts's own doc comment — importing via index.ts must not throw a TDZ error at module load", () => {
    // If index.ts's `export * from "./plan"` were positioned such that
    // plan.ts's own top-level code needed something from index.ts that
    // isn't initialized yet, this import would already have thrown before
    // this test file's body ever ran. Reaching this line at all is the
    // real assertion; the schema check below is just a bonus sanity check.
    expect(TaskSchema).toBeDefined();
  });

  it("validates a real, complete Task", () => {
    const result = TaskSchema.safeParse({ id: "t1", description: "Archive the Acme Co. invoice", doneContract: "Acme Co.'s invoice shows status Archived", status: "pending" });
    expect(result.success).toBe(true);
  });

  it("rejects an invented status not in TASK_STATUSES", () => {
    const result = TaskSchema.safeParse({ id: "t1", description: "x", doneContract: "x", status: "maybe" });
    expect(result.success).toBe(false);
  });

  it("validates a real, complete Plan with a version and real tasks", () => {
    const result = PlanSchema.safeParse({
      version: 1,
      goal: "Archive my old invoices",
      facts: ["Acme Co. is $1,200, over the $1000 threshold"],
      tasks: [{ id: "t1", description: "Ask before archiving Acme Co.", doneContract: "The user has confirmed", status: "in_progress" }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a Plan with an empty tasks array — a plan must always have at least one real task", () => {
    const result = PlanSchema.safeParse({ version: 1, goal: "x", facts: [], tasks: [] });
    expect(result.success).toBe(false);
  });

  it("PlannerOutputSchema deliberately excludes version/status — harness-owned fields the model shouldn't invent", () => {
    const result = PlannerOutputSchema.safeParse({
      goal: "Archive my old invoices",
      facts: [],
      tasks: [{ id: "t1", description: "Archive Globex Inc.", doneContract: "Globex Inc. shows status Archived" }],
    });
    expect(result.success).toBe(true);
    // A version or status field would be rejected — the schema is .strict().
    const withExtra = PlannerOutputSchema.safeParse({
      goal: "x",
      facts: [],
      tasks: [{ id: "t1", description: "x", doneContract: "x", status: "pending" }],
    });
    expect(withExtra.success).toBe(false);
  });

  it("validates a real ProgressLedger", () => {
    const result = ProgressLedgerSchema.safeParse({ planVersion: 1, currentTaskIndex: 0, stallCount: 0 });
    expect(result.success).toBe(true);
  });
});

describe("CriticVerdictSchema", () => {
  it("validates a real task_complete verdict with no expected/actual diff needed", () => {
    const result = CriticVerdictSchema.safeParse({ verdict: "task_complete", reasoning: "The invoice now shows status Archived, matching the task's doneContract." });
    expect(result.success).toBe(true);
  });

  it("validates a real replan verdict carrying PIVOT's expected-vs-actual diff", () => {
    const result = CriticVerdictSchema.safeParse({
      verdict: "replan",
      expected: "Globex Inc. status is Archived",
      actual: "Globex Inc. status is still Overdue",
      reasoning: "The click didn't register — the row still shows the original status.",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invented verdict not in CRITIC_VERDICTS", () => {
    const result = CriticVerdictSchema.safeParse({ verdict: "looks_fine", reasoning: "x" });
    expect(result.success).toBe(false);
  });

  it("requires real reasoning — never a silent verdict with no explanation", () => {
    const result = CriticVerdictSchema.safeParse({ verdict: "continue" });
    expect(result.success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { scenarios } from "./index";

describe("scenarios/index — template expansion", () => {
  it("the two workflow templates each expand into their real variant count, not collapse to one", () => {
    const emailScenarios = scenarios.filter((s) => s.id.startsWith("workflow-email-on-form-submit-"));
    const slackScenarios = scenarios.filter((s) => s.id.startsWith("workflow-slack-notification-"));
    expect(emailScenarios).toHaveLength(2);
    expect(slackScenarios).toHaveLength(2);
    // Genuinely distinct goals per variant, not the same text twice.
    expect(new Set(emailScenarios.map((s) => s.goal)).size).toBe(2);
    expect(new Set(slackScenarios.map((s) => s.goal)).size).toBe(2);
  });

  it("every scenario id in the suite is unique — template expansion never collides with a hand-written scenario", () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("suite size grew from the original 5 hand-written scenarios to 7 via template expansion", () => {
    expect(scenarios.length).toBe(7);
  });
});

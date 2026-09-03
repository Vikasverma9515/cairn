import { describe, expect, it } from "vitest";
import { expandTemplate, expandTemplates, type ScenarioTemplate } from "./templates";

function makeTemplate(overrides: Partial<ScenarioTemplate> = {}): ScenarioTemplate {
  return {
    id: "archive-by-client",
    name: "Archive an invoice by client name",
    capabilities: ["content-ops"],
    baseUrl: "http://localhost:3000",
    path: "/invoices",
    goalTemplate: "Archive the invoice for {clientName}.",
    verify: {
      path: "/api/invoices",
      expectContainsTemplate: ["\"client\":\"{clientName}\"", "\"status\":\"Archived\""],
    },
    variants: [{ clientName: "New Client" }, { clientName: "Globex Inc" }],
    ...overrides,
  };
}

describe("expandTemplate", () => {
  it("real bug this specifically guards against: produces GENUINELY distinct scenarios per variant, not cosmetic goal-text-only changes", () => {
    const scenarios = expandTemplate(makeTemplate());
    expect(scenarios).toHaveLength(2);
    expect(scenarios[0].goal).toBe("Archive the invoice for New Client.");
    expect(scenarios[1].goal).toBe("Archive the invoice for Globex Inc.");
    // The verify check itself must differ per variant, not just the goal text.
    expect(scenarios[0].verify.expectContains).toEqual(["\"client\":\"New Client\"", "\"status\":\"Archived\""]);
    expect(scenarios[1].verify.expectContains).toEqual(["\"client\":\"Globex Inc\"", "\"status\":\"Archived\""]);
  });

  it("gives each variant a unique, stable id derived from the template id", () => {
    const scenarios = expandTemplate(makeTemplate());
    expect(scenarios.map((s) => s.id)).toEqual(["archive-by-client-1", "archive-by-client-2"]);
  });

  it("carries capabilities, path, and baseUrl through unchanged from the template", () => {
    const scenarios = expandTemplate(makeTemplate());
    for (const s of scenarios) {
      expect(s.capabilities).toEqual(["content-ops"]);
      expect(s.path).toBe("/invoices");
      expect(s.baseUrl).toBe("http://localhost:3000");
    }
  });

  it("leaves a placeholder with no matching variant param untouched instead of silently dropping it", () => {
    const scenarios = expandTemplate(
      makeTemplate({ goalTemplate: "Archive the invoice for {clientName} in {region}.", variants: [{ clientName: "New Client" }] }),
    );
    expect(scenarios[0].goal).toBe("Archive the invoice for New Client in {region}.");
  });

  it("substitutes a single-string expectContainsTemplate the same way as an array", () => {
    const scenarios = expandTemplate(
      makeTemplate({ verify: { path: "/api/invoices", expectContainsTemplate: "{clientName}" } }),
    );
    expect(scenarios[0].verify.expectContains).toBe("New Client");
  });
});

describe("expandTemplates", () => {
  it("flattens multiple templates into one combined scenario list", () => {
    const t1 = makeTemplate({ id: "a", variants: [{ clientName: "X" }] });
    const t2 = makeTemplate({ id: "b", variants: [{ clientName: "Y" }, { clientName: "Z" }] });
    const scenarios = expandTemplates([t1, t2]);
    expect(scenarios.map((s) => s.id)).toEqual(["a-1", "b-1", "b-2"]);
  });
});

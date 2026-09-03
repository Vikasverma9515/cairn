// Scaling scenario coverage without hand-writing every case — WebArena's
// 241-templates-to-812-tasks technique (research item #5): define a
// scenario once as a parameterized template, expand it into several
// concrete instances. Growing the suite becomes "add a template + a
// couple of variants," not "hand-write N more scenarios."
//
// Deliberately NOT a full cartesian expansion across independent parameter
// pools — that risks combinatorial explosion and produces variants nobody
// actually chose. Each template lists explicit, hand-picked `variants`
// (WebArena's own ratio was a modest ~3.3 per template, not an exhaustive
// product), keeping every generated scenario something a real person would
// actually ask for.

import type { Scenario, Transport } from "./scenario";
import type { CapabilityTag } from "./taxonomy";

export interface ScenarioTemplate {
  id: string;
  name: string;
  capabilities: CapabilityTag[];
  baseUrl: string;
  path: string;
  /** `{param}` placeholders, substituted per variant. */
  goalTemplate: string;
  transports?: Transport[];
  setup?: { path: string; method?: string }[];
  verify: {
    path: string;
    method?: string;
    /** May contain `{param}` placeholders, substituted per variant. */
    expectContainsTemplate: string | string[];
  };
  rubricNotes?: string;
  /** Each entry is one concrete scenario instance's parameter values. */
  variants: Record<string, string>[];
}

function substitute(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => params[key] ?? match);
}

/** Expands one template into its real, concrete scenario instances. */
export function expandTemplate(template: ScenarioTemplate): Scenario[] {
  return template.variants.map((params, index) => ({
    id: `${template.id}-${index + 1}`,
    name: `${template.name} (${Object.values(params).join(", ")})`,
    capabilities: template.capabilities,
    baseUrl: template.baseUrl,
    path: template.path,
    goal: substitute(template.goalTemplate, params),
    transports: template.transports,
    setup: template.setup,
    verify: {
      path: template.verify.path,
      method: template.verify.method,
      expectContains: Array.isArray(template.verify.expectContainsTemplate)
        ? template.verify.expectContainsTemplate.map((e) => substitute(e, params))
        : substitute(template.verify.expectContainsTemplate, params),
    },
    rubricNotes: template.rubricNotes,
  }));
}

export function expandTemplates(templates: ScenarioTemplate[]): Scenario[] {
  return templates.flatMap(expandTemplate);
}

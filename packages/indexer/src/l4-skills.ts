// L4 — feature skills. The one phase that reads the whole code behind each page (not just the page file:
// its components, server actions, API routes, data shapes and business rules) and writes, for every feature,
// an operating guide for the agent: what it is for, what has to be true first, the exact controls to press in
// order, which API / server action / table each step reaches, the fields and rules, what happens after and
// what to watch out for. A second pass links features into workflows that span pages. The result is stored
// on the manifest (`skills`), so the running agent gets it with no extra wiring.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { slugifySkillId, type Element, type Manifest, type Page, type Skill } from "@cairnvibe/core";
import { mapWithConcurrency, withRetry, type RetryInfo } from "./concurrency";
import type { SkillWriterClient, ToolSpec } from "./l4-client";
import type { RawFacts, RawPage } from "./types";

const CACHE_DIR = ".cairn-cache";
const PROMPT_VERSION = "l4-v1";
const FILE_CAP = 7000;
const TOTAL_CAP = 48000;
const DEFAULT_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// What the model returns
// ---------------------------------------------------------------------------

export interface Feature {
  name: string;
  summary: string;
  useWhen: string[];
  requires: string[];
  steps: { do: string; control: string; expect: string }[];
  apis: { kind: string; name: string; method: string; url: string; purpose: string }[];
  data: { field: string; required: boolean; rules: string }[];
  outcome: string;
  watchOut: string[];
  asksFirst: boolean;
}

export interface Workflow {
  name: string;
  summary: string;
  steps: { page: string; do: string; control: string }[];
  asksFirst: boolean;
}

const str = { type: "string" as const };
const strList = { type: "array" as const, items: str };

export const FEATURES_TOOL: ToolSpec = {
  name: "write_feature_skills",
  description: "Report every distinct user-facing feature on this page as an operating guide an AI agent can follow to use it.",
  schema: {
    type: "object",
    properties: {
      features: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { ...str, description: "What the person gets done, as a short action: 'Reject a candidate', 'Add a job'." },
            summary: { ...str, description: "One or two sentences: what this feature does and why someone uses it." },
            useWhen: { ...strList, description: "Phrases a person might say when they want this ('reject someone', 'turn down an applicant')." },
            requires: { ...strList, description: "What must be true or provided first: page to be on, required inputs, prior state, permissions, integrations connected." },
            steps: {
              type: "array",
              description: "The exact order of actions in the UI.",
              items: {
                type: "object",
                properties: {
                  do: { ...str, description: "The action, imperative ('Click Reject', 'Type the full name')." },
                  control: { ...str, description: "The exact control id or label from the controls list, or '' when the step is not a control." },
                  expect: { ...str, description: "What you should see or what happens next." },
                },
                required: ["do", "control", "expect"],
              },
            },
            apis: {
              type: "array",
              description: "Every server action, HTTP route, database table or external service this feature reaches, as found in the code.",
              items: {
                type: "object",
                properties: {
                  kind: { ...str, description: "server-action | http | database | external | other" },
                  name: { ...str, description: "Function, route or table name from the code." },
                  method: { ...str, description: "HTTP method or operation (POST, insert, update...), or ''." },
                  url: { ...str, description: "Route or endpoint, or ''." },
                  purpose: { ...str, description: "What it does for this feature." },
                },
                required: ["kind", "name", "method", "url", "purpose"],
              },
            },
            data: {
              type: "array",
              description: "Inputs and fields this feature reads or writes, with validation from the code.",
              items: {
                type: "object",
                properties: { field: str, required: { type: "boolean" }, rules: { ...str, description: "Format, limits, allowed values, defaults." } },
                required: ["field", "required", "rules"],
              },
            },
            outcome: { ...str, description: "What changes afterwards: navigation, saved data, status change, message sent." },
            watchOut: { ...strList, description: "Failure cases, side effects, ordering traps, things that cannot be undone." },
            asksFirst: { type: "boolean", description: "True if it changes data irreversibly or contacts a real person (message, email, call, payment, delete)." },
          },
          required: ["name", "summary", "useWhen", "requires", "steps", "apis", "data", "outcome", "watchOut", "asksFirst"],
        },
      },
    },
    required: ["features"],
  },
};

export const WORKFLOWS_TOOL: ToolSpec = {
  name: "write_workflow_skills",
  description: "Report the end-to-end workflows that span more than one page.",
  schema: {
    type: "object",
    properties: {
      workflows: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { ...str, description: "The goal, as an action: 'Hire a candidate end to end'." },
            summary: str,
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  page: { ...str, description: "The route this step happens on." },
                  do: { ...str, description: "What to do, naming the feature or control." },
                  control: { ...str, description: "Exact control id/label, or ''." },
                },
                required: ["page", "do", "control"],
              },
            },
            asksFirst: { type: "boolean" },
          },
          required: ["name", "summary", "steps", "asksFirst"],
        },
      },
    },
    required: ["workflows"],
  },
};

const FEATURE_SYSTEM = `You are documenting a web app for an AI agent that will operate it through the browser: it can navigate, click, type into fields, choose options and read the page, and it must use the app fully and correctly for whatever a person asks.

You are given one page: its route, the controls on it (with the exact ids/labels the agent can target), and the source code behind it: the page, its components, server actions, API routes, data shapes and business rules.

Write one operating guide per distinct feature the page offers. A feature is something a person gets done ("Reject a candidate", "Schedule an interview", "Add a job", "Filter by stage"), not a description of the page. Cover everything a person can do here, including the small ones (search, filter, sort, open details). Skip pure decoration.

For every feature:
- steps: the exact order of actions. Each step's "control" must be an id or label copied from the controls list; never invent a control. If a step needs a page other than this one, say so under requires and in the step.
- apis: name what each step really reaches, read from the code: the server action or function, the fetch URL and method, the database table and operation (for example a supabase .from("candidates").update), external services. Use the names as they appear in the code.
- data and validation: required fields, formats, limits, defaults and what the code rejects.
- requires: what must be true first (a candidate selected, a form filled, an integration connected, a status the record must have).
- outcome and watchOut: what changes afterwards, failure cases, side effects, confirmation dialogs, anything that cannot be undone.
- asksFirst: true when it deletes or irreversibly changes data, or contacts a real person (email, message, phone call, payment).

Only state what the code and controls support. If something is unclear, say what is known and leave the rest out. Write for the agent, in the imperative, concrete and specific.`;

const WORKFLOW_SYSTEM = `You are documenting a web app for an AI agent. You are given the features found on each page. Identify the end-to-end workflows a person carries out that span more than one page (for example: add a candidate, screen them, shortlist, schedule an interview, collect feedback, send an offer). For each, list the ordered steps with the page each happens on and the exact control ids/labels copied from the features. Only include workflows the features support; do not invent steps. Return between 0 and 10 workflows. Set asksFirst when any step deletes data irreversibly or contacts a real person.`;

// ---------------------------------------------------------------------------
// Reading the code behind a page
// ---------------------------------------------------------------------------

const SKIP_FILE_RE = /\.(test|spec|stories)\.|(^|\/)(node_modules|\.next|dist)\/|components\/ui\/|\.css$|\.svg$/;

function filePriority(file: string, page: RawPage, elementFiles: Set<string>): number {
  if (file === page.file) return 0;
  if (elementFiles.has(file)) return 1;
  if (/(^|\/)(actions?|api|server|services?)\//.test(file) || /(^|\/)route\.(t|j)sx?$/.test(file)) return 2;
  return 3;
}

export interface PageContext {
  files: { path: string; source: string }[];
  truncated: boolean;
}

/** The page's own file first, then components with controls, server actions and routes, then the rest, within a size budget. */
export function gatherPageContext(absRoot: string, page: RawPage, facts: RawFacts): PageContext {
  const elementFiles = new Set(page.elements.map((e) => e.file));
  const wanted = new Set(page.reachableFiles);
  // API routes the page's controls call, even when nothing imports them.
  const calls = page.elements.map((e) => e.handlerCall ?? "").join(" ");
  for (const handler of facts.apiRouteHandlers) if (handler.url && calls.includes(handler.url)) wanted.add(handler.file);

  const ordered = [...wanted]
    .filter((f) => !SKIP_FILE_RE.test(f))
    .sort((a, b) => filePriority(a, page, elementFiles) - filePriority(b, page, elementFiles) || a.localeCompare(b));
  const files: PageContext["files"] = [];
  let total = 0;
  let truncated = false;
  for (const rel of ordered) {
    let source: string;
    try {
      source = fs.readFileSync(path.join(absRoot, rel), "utf8");
    } catch {
      continue;
    }
    if (source.length > FILE_CAP) {
      source = `${source.slice(0, FILE_CAP)}\n/* ... file truncated ... */`;
      truncated = true;
    }
    if (total + source.length > TOTAL_CAP) {
      truncated = true;
      break;
    }
    total += source.length;
    files.push({ path: rel, source });
  }
  return { files, truncated };
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1).trimEnd()}...` : value);

function controlsFor(page: Page): Element[] {
  const seen = new Set<string>();
  const out: Element[] = [];
  for (const el of page.elements) {
    if (el.confidence < 0.4 || /^unknown/i.test(el.does)) continue;
    if (/(\.\.\.)$/.test(el.label.trim())) continue;
    const key = el.id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
    if (out.length >= 70) break;
  }
  return out;
}

export function buildPagePrompt(page: Page, raw: RawPage, context: PageContext, facts: RawFacts): string {
  const controls = controlsFor(page).map(
    (el) => `- id: ${el.id} | label: ${clip(el.label, 60)} | does: ${clip(el.does, 200)}${el.apiCall ? ` | api: ${el.apiCall.method} ${el.apiCall.url}` : ""}`,
  );
  const shapes = (raw.dataShapes ?? []).map((d) => `- ${d.name}: ${d.fields.map((f) => `${f.name}${f.optional ? "?" : ""}: ${f.type}`).join(", ")}`);
  const includedFiles = new Set(context.files.map((f) => f.path));
  const rules = facts.businessRules.filter((r) => includedFiles.has(r.source)).map((r) => `- ${r.functionName}: if ${clip(r.condition, 120)} then ${clip(r.consequence, 120)}`);
  const routes = facts.apiRouteHandlers
    .filter((h) => includedFiles.has(h.file))
    .map((h) => `- ${h.method} ${h.url} (${h.file})${h.calls.length ? ` calls: ${h.calls.join(", ")}` : ""}`);
  return [
    `ROUTE: ${page.route}`,
    `PAGE PURPOSE: ${clip(page.purpose, 400)}`,
    `WHEN TO USE: ${clip(page.whenToUse, 300)}`,
    "",
    "CONTROLS ON THIS PAGE (copy ids or labels exactly):",
    controls.join("\n") || "(none found)",
    shapes.length ? `\nDATA SHAPES:\n${shapes.join("\n")}` : "",
    rules.length ? `\nBUSINESS RULES FOUND IN THE CODE:\n${rules.join("\n")}` : "",
    routes.length ? `\nAPI ROUTES:\n${routes.join("\n")}` : "",
    context.truncated ? "\n(Some files were shortened to fit.)" : "",
    "\nSOURCE CODE:",
    ...context.files.map((f) => `\n### ${f.path}\n${f.source}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Turning the model's answer into skills
// ---------------------------------------------------------------------------

const text = (v: unknown, max = 600): string => (typeof v === "string" ? clip(v.replace(/\s+/g, " ").trim(), max) : "");
const list = (v: unknown, max = 8, len = 240): string[] => (Array.isArray(v) ? v.map((x) => text(x, len)).filter(Boolean).slice(0, max) : []);
const objs = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : []);

/** Defensive: models return slightly off shapes. Keep what is usable, drop the rest, never throw. */
export function normalizeFeatures(raw: unknown): Feature[] {
  const features = objs((raw as { features?: unknown } | null)?.features);
  return features
    .map((f) => ({
      name: text(f.name, 90),
      summary: text(f.summary, 400),
      useWhen: list(f.useWhen, 8, 120),
      requires: list(f.requires, 10),
      steps: objs(f.steps)
        .map((s) => ({ do: text(s.do, 240), control: text(s.control, 90), expect: text(s.expect, 240) }))
        .filter((s) => s.do)
        .slice(0, 20),
      apis: objs(f.apis)
        .map((a) => ({ kind: text(a.kind, 30), name: text(a.name, 90), method: text(a.method, 20), url: text(a.url, 120), purpose: text(a.purpose, 240) }))
        .filter((a) => a.name)
        .slice(0, 12),
      data: objs(f.data)
        .map((d) => ({ field: text(d.field, 60), required: d.required === true, rules: text(d.rules, 240) }))
        .filter((d) => d.field)
        .slice(0, 20),
      outcome: text(f.outcome, 300),
      watchOut: list(f.watchOut, 8),
      asksFirst: f.asksFirst === true,
    }))
    .filter((f) => f.name && f.steps.length > 0);
}

export function normalizeWorkflows(raw: unknown): Workflow[] {
  return objs((raw as { workflows?: unknown } | null)?.workflows)
    .map((w) => ({
      name: text(w.name, 90),
      summary: text(w.summary, 400),
      steps: objs(w.steps)
        .map((s) => ({ page: text(s.page, 90), do: text(s.do, 240), control: text(s.control, 90) }))
        .filter((s) => s.do)
        .slice(0, 20),
      asksFirst: w.asksFirst === true,
    }))
    .filter((w) => w.name && w.steps.length > 1);
}

const ASK_FIRST = "Changes data or contacts someone: tell the person exactly what you are about to do and get a yes in chat before the final press.";
const EPOCH = "1970-01-01T00:00:00.000Z";

export function renderFeatureSkill(route: string, f: Feature): Skill {
  const lines: string[] = [`Feature: ${f.name}`, `Page: ${route}`, f.summary];
  if (f.useWhen.length) lines.push("", "Use it when the person says things like:", ...f.useWhen.map((u) => `- ${u}`));
  if (f.requires.length) lines.push("", "Requires:", ...f.requires.map((r) => `- ${r}`));
  lines.push("", "Steps:", ...f.steps.map((s, i) => `${i + 1}. ${s.do}${s.control ? ` [control: ${s.control}]` : ""}${s.expect ? ` -> ${s.expect}` : ""}`));
  if (f.apis.length) lines.push("", "What it reaches:", ...f.apis.map((a) => `- ${[a.kind, a.method, a.name, a.url].filter(Boolean).join(" ")}: ${a.purpose}`));
  if (f.data.length) lines.push("", "Fields and rules:", ...f.data.map((d) => `- ${d.field}${d.required ? " (required)" : ""}: ${d.rules}`));
  if (f.outcome) lines.push("", `Result: ${f.outcome}`);
  if (f.watchOut.length) lines.push("", "Watch out:", ...f.watchOut.map((w) => `- ${w}`));
  if (f.asksFirst) lines.push("", ASK_FIRST);
  return {
    id: `feature-${slugifySkillId(route === "/" ? "home" : route)}-${slugifySkillId(f.name)}`,
    name: f.name,
    description: clip(f.summary, 200),
    instructions: lines.join("\n"),
    createdAt: EPOCH,
  };
}

export function renderWorkflowSkill(w: Workflow): Skill {
  const lines = [`Workflow: ${w.name}`, w.summary, "", "Steps:", ...w.steps.map((s, i) => `${i + 1}. [${s.page}] ${s.do}${s.control ? ` [control: ${s.control}]` : ""}`)];
  if (w.asksFirst) lines.push("", ASK_FIRST);
  return { id: `workflow-${slugifySkillId(w.name)}`, name: w.name, description: clip(w.summary, 200), instructions: lines.join("\n"), createdAt: EPOCH };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface L4Result {
  skills: Skill[];
  cacheHits: number;
  cacheMisses: number;
  failedPages: string[];
}

function cached<T>(cacheDir: string, key: string, read: (raw: unknown) => T[]): T[] | null {
  const file = path.join(cacheDir, `skills-${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const value = read(JSON.parse(fs.readFileSync(file, "utf8")));
    return value.length ? value : null;
  } catch {
    return null;
  }
}

const hashOf = (...parts: string[]) => crypto.createHash("sha256").update([PROMPT_VERSION, ...parts].join("|||")).digest("hex").slice(0, 32);

export async function buildFeatureSkills(
  rootDir: string,
  facts: RawFacts,
  manifest: Manifest,
  client: SkillWriterClient,
  options: { concurrency?: number; onRetry?: (info: RetryInfo) => void; onProgress?: (done: number, total: number) => void } = {},
): Promise<L4Result> {
  const absRoot = path.resolve(rootDir);
  const cacheDir = path.join(absRoot, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const rawByRoute = new Map(facts.pages.map((p) => [p.route, p]));
  const pages = manifest.pages.filter((p) => rawByRoute.has(p.route) && !/^unknown/i.test(p.purpose));
  const perPage = new Map<string, Feature[]>();
  const failedPages: string[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let done = 0;

  await mapWithConcurrency(pages, options.concurrency ?? DEFAULT_CONCURRENCY, async (page) => {
    const raw = rawByRoute.get(page.route)!;
    const user = buildPagePrompt(page, raw, gatherPageContext(absRoot, raw, facts), facts);
    const key = hashOf(FEATURE_SYSTEM, user);
    const hit = cached(cacheDir, key, normalizeFeatures);
    if (hit) {
      perPage.set(page.route, hit);
      cacheHits += 1;
    } else {
      try {
        const answer = await withRetry(() => client.callTool(FEATURE_SYSTEM, user, FEATURES_TOOL), { onRetry: options.onRetry });
        const features = normalizeFeatures(answer);
        perPage.set(page.route, features);
        // Only a real, non-empty answer is cached; a failure or an empty page is retried next build.
        if (features.length) fs.writeFileSync(path.join(cacheDir, `skills-${key}.json`), JSON.stringify({ features }, null, 2));
        cacheMisses += 1;
      } catch (err) {
        console.error(`[cairn] writing feature skills for ${page.route} failed after retries - skipping this page:`, err);
        failedPages.push(page.route);
      }
    }
    options.onProgress?.(++done, pages.length);
  });

  const skills: Skill[] = [];
  for (const page of pages) for (const f of perPage.get(page.route) ?? []) skills.push(renderFeatureSkill(page.route, f));

  // Workflows across pages, from the features just written.
  if (skills.length >= 3) {
    const digest = pages
      .flatMap((page) => (perPage.get(page.route) ?? []).map((f) => `- [${page.route}] ${f.name}: ${f.summary} | steps: ${f.steps.map((s) => s.control || s.do).join(" > ")}`))
      .join("\n");
    const key = hashOf(WORKFLOW_SYSTEM, digest);
    let workflows = cached(cacheDir, key, normalizeWorkflows);
    if (workflows) cacheHits += 1;
    else {
      try {
        const answer = await withRetry(() => client.callTool(WORKFLOW_SYSTEM, digest, WORKFLOWS_TOOL), { onRetry: options.onRetry });
        workflows = normalizeWorkflows(answer);
        if (workflows.length) fs.writeFileSync(path.join(cacheDir, `skills-${key}.json`), JSON.stringify({ workflows }, null, 2));
        cacheMisses += 1;
      } catch (err) {
        console.error("[cairn] writing workflow skills failed after retries - skipping workflows:", err);
        workflows = [];
      }
    }
    skills.push(...workflows.map(renderWorkflowSkill));
  }

  return { skills, cacheHits, cacheMisses, failedPages };
}

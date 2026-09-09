// Turns one real copilot round trip's raw request/response JSON into a
// human-readable line — "clicked X", "typed Y into Z" — so the trace view
// reads like a real narrative of what the agent did, not a wall of JSON
// (the raw request/response is still available, just not the DEFAULT
// view — see Braintrust's own trace-card pattern: one input/output line
// per real step, full payload one click away). Mirrors the verb shapes
// @cairnvibe/sdk's own summarizeVerbForHistory (agent-loop.ts) already
// established — not re-exported from the SDK's package.json exports map,
// so duplicated here rather than reaching into its internals.
//
// Real, live-found bug this file's own earlier version had: `copilotRoundTrips`
// records EVERY real HTTP round trip the widget makes during a turn —
// not just /api/copilot's own verb calls, but /api/copilot/plan and
// /api/copilot/critic too (Architecture Pillar 4's Planner/Critic loop).
// Those two have genuinely different response shapes (`{tasks: [...]}`,
// `{verdict: "continue"|"replan"|...}`) with no `verb` field at all — the
// original summarizer treated every one of those as "no valid verb in
// response — unparseable," which looked exactly like a real parsing
// failure in the trace view even though the agent was working completely
// correctly. Confirmed live: a real trial's own raw round trips showed
// real Plan objects and real Critic verdicts wrongly painted red as
// "NO VERB" errors — a bug in this dashboard's OWN code, not the agent.
export type StepKind = "verb" | "plan" | "critic" | "unparseable";

export interface StepSummary {
  kind: StepKind;
  verb: string | null;
  headline: string;
  question: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function summarizeVerbResponse(res: Record<string, unknown>): { verb: string; headline: string } {
  const verb = res.verb as string;
  const text = typeof res.text === "string" ? res.text : null;
  const target = typeof res.target === "string" ? res.target : null;
  const value = typeof res.value === "string" ? res.value : null;
  const route = typeof res.route === "string" ? res.route : null;
  const action = typeof res.action === "string" ? res.action : null;
  const name = typeof res.name === "string" ? res.name : null;
  const key = typeof res.key === "string" ? res.key : null;
  const to = typeof res.to === "string" ? res.to : null;

  switch (verb) {
    case "explain":
      return { verb, headline: `explained: "${text ?? ""}"` };
    case "highlight":
    case "open":
      return { verb, headline: `${verb === "open" ? "opened" : "highlighted"} ${target ?? "?"}${text ? ` — "${text}"` : ""}` };
    case "navigate":
      return { verb, headline: `navigated to ${route ?? "?"}${text ? ` — "${text}"` : ""}` };
    case "do":
      return { verb, headline: `ran action "${action ?? "?"}"${target ? ` on ${target}` : ""}` };
    case "click":
      return { verb, headline: `clicked ${target ?? "?"}` };
    case "fill":
      return { verb, headline: `typed "${value ?? ""}" into ${target ?? "?"}` };
    case "read":
      return { verb, headline: `read ${target ?? "?"}` };
    case "call_tool":
      return { verb, headline: `called tool "${name ?? "?"}"` };
    case "drag":
      return { verb, headline: `dragged ${target ?? "?"} to ${to ?? "?"}` };
    case "select":
      return { verb, headline: `selected "${value ?? ""}" in ${target ?? "?"}` };
    case "key":
      return { verb, headline: `pressed ${key ?? "?"}${target ? ` on ${target}` : ""}` };
    case "batch": {
      const actions = Array.isArray(res.actions) ? (res.actions as unknown[]) : [];
      const parts = actions
        .map((a) => {
          const ar = asRecord(a);
          if (!ar || typeof ar.verb !== "string") return null;
          return summarizeVerbResponse(ar).headline;
        })
        .filter((x): x is string => x !== null);
      return { verb, headline: `batch (${actions.length} steps): ${parts.join("; ")}` };
    }
    case "tour": {
      const steps = Array.isArray(res.steps) ? res.steps.length : 0;
      return { verb, headline: `gave a ${steps}-step tour` };
    }
    default:
      return { verb, headline: `verb "${verb}"` };
  }
}

export function summarizeRoundTrip(requestBody: unknown, responseBody: unknown): StepSummary {
  const req = asRecord(requestBody);
  const res = asRecord(responseBody);
  const question = req && typeof req.question === "string" ? req.question : null;

  if (!res) {
    return { kind: "unparseable", verb: null, headline: "Empty or unparseable response", question };
  }

  // A real Planner call (resolvePlan) — {version, goal, tasks: [...]}.
  if (Array.isArray(res.tasks) && typeof res.goal === "string") {
    const task = asRecord(res.tasks[0]);
    const taskDesc = task && typeof task.description === "string" ? task.description : null;
    return {
      kind: "plan",
      verb: null,
      headline: `Planner: ${res.tasks.length} task${res.tasks.length === 1 ? "" : "s"}${taskDesc ? ` — "${taskDesc}"` : ""}`,
      question,
    };
  }

  // A real Critic verdict (resolveCritic) — {verdict, reasoning, ...}.
  if (typeof res.verdict === "string" && typeof res.reasoning === "string") {
    return { kind: "critic", verb: null, headline: `Critic: ${res.verdict} — "${res.reasoning}"`, question };
  }

  if (typeof res.verb === "string") {
    const { verb, headline } = summarizeVerbResponse(res);
    return { kind: "verb", verb, headline, question };
  }

  return { kind: "unparseable", verb: null, headline: "No valid verb, plan, or verdict in response — genuinely unparseable", question };
}

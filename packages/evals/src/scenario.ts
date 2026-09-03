// The scenario format — data, not code, so adding a new eval case never
// touches the harness itself. Deliberately mirrors how a real user would
// actually phrase a request (an end goal, never a click-here instruction) —
// see DEVELOPMENT.md/the eval plan for why that distinction matters.

import type { CapabilityTag } from "./taxonomy";

export type Transport = "typed" | "voice";

export interface Scenario {
  /** Short, stable id — used as the SQLite key and the judge's report label. */
  id: string;
  /** Human-readable name for CLI output. */
  name: string;
  /** Which capability dimensions this scenario exercises (taxonomy.ts) —
   * required, not optional: an untagged scenario can't be aggregated into
   * the dashboard's "how good are we at X" capability breakdown, which
   * defeats the point of having the taxonomy at all. */
  capabilities: CapabilityTag[];
  /** Base URL the playground app is already running at (see README — the
   * harness doesn't manage the dev server's lifecycle, same convention
   * `cairn build <url>` already uses for crawl mode). */
  baseUrl: string;
  /** Path to load before speaking/typing the goal, e.g. "/workflows". */
  path: string;
  /** The end goal, phrased the way a real person would say it out loud —
   * never "click the X button". This is what gets typed (typed transport)
   * or synthesized to speech (voice transport). */
  goal: string;
  /** Which transports to run this scenario against. Defaults to both. */
  transports?: Transport[];
  /** Optional: a fetch to run before the goal (e.g. reset playground state
   * so runs are independent) — path + method, resolved against baseUrl. */
  setup?: { path: string; method?: string }[];
  /** What "done" means for this scenario, checked against real state after
   * the run — not the model's own claim that it succeeded. `verify` runs
   * in Node against the app's own API, `path`/`method`/`expect` describe a
   * simple fetch-and-match check when a full function isn't needed. */
  verify: {
    path: string;
    method?: string;
    /** A substring (or set of substrings) the JSON-stringified response
     * body must contain for the scenario to count as achieved. */
    expectContains: string | string[];
  };
  /** Extra rubric guidance for the judge beyond the standard dimensions
   * (task success, efficiency, correctness, safety, latency for voice). */
  rubricNotes?: string;
}

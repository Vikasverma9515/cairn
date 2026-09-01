// Turns a raw server response into a UI action — or, on anything that fails
// validation, into a plain explain. This is the client-side half of
// BUILD_PLAN.md invariant #1 ("the LLM never emits code or selectors, only a
// verb from a fixed list") and invariant #3 ("any lookup failure degrades to
// explain — never guess, never wrong-click"). The server (`server.ts`)
// enforces the same schema independently — never trust the client alone.

import { VerbResponseSchema, type TourStep, type VerbResponse } from "@cairnvibe/core";
import { findElement, highlightElement, logMiss, type MissContext } from "./element-ladder";

export interface VerbExecutorOptions {
  onExplain: (text: string) => void;
  onNavigate?: (route: string) => void;
  onDo?: (action: string, target?: string) => void;
  onMiss?: (context: MissContext) => void;
  /**
   * A multi-step guided walkthrough (2-6 steps). Highlighting/timing/speech
   * is NOT done here — this just hands the raw steps to the caller, which
   * owns the UI (progress display) and, for voice, the TTS sequencing.
   */
  onTour?: (steps: TourStep[]) => void;
  /** Action ids the customer has actually wired up. "do" is rejected for anything else. */
  registeredActions?: string[];
}

const FALLBACK_TEXT = "I'm not sure — I couldn't understand that response. Try rephrasing your question.";

export function executeVerbResponse(raw: unknown, route: string, options: VerbExecutorOptions): void {
  const parsed = VerbResponseSchema.safeParse(raw);
  if (!parsed.success) {
    options.onExplain(FALLBACK_TEXT);
    return;
  }

  dispatchVerb(parsed.data, route, options);
}

function dispatchVerb(verb: VerbResponse, route: string, options: VerbExecutorOptions): void {
  switch (verb.verb) {
    case "explain":
      options.onExplain(verb.text);
      return;

    case "highlight":
    case "open": {
      const el = findElement(verb.target);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onExplain(verb.text ?? "I know what you need, but I can't find it on this page right now.");
        return;
      }
      highlightElement(el);
      if (verb.text) options.onExplain(verb.text);
      return;
    }

    case "navigate":
      options.onNavigate?.(verb.route);
      if (verb.text) options.onExplain(verb.text);
      return;

    case "do": {
      const allowed = options.registeredActions ?? [];
      if (!allowed.includes(verb.action)) {
        options.onExplain("That action isn't available here.");
        return;
      }
      options.onDo?.(verb.action, verb.target);
      if (verb.text) options.onExplain(verb.text);
      return;
    }

    case "tour":
      if (options.onTour) {
        options.onTour(verb.steps);
      } else {
        // Caller doesn't support tours (e.g. an older host app) — degrade
        // to reading the steps out as one explanation rather than dropping
        // the reply silently.
        options.onExplain(verb.steps.map((s) => s.text).join(" "));
      }
      return;
  }
}

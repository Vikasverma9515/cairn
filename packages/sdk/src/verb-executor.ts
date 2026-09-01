// Turns a raw server response into a UI action — or, on anything that fails
// validation, into a plain explain. This is the client-side half of
// BUILD_PLAN.md invariant #1 ("the LLM never emits code or selectors, only a
// verb from a fixed list") and invariant #3 ("any lookup failure degrades to
// explain — never guess, never wrong-click"). The server (`server.ts`)
// enforces the same schema independently — never trust the client alone.

import { VerbResponseSchema, type ApiCall, type TourStep, type VerbResponse } from "@cairnvibe/core";
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
  /**
   * This turn's frozen runtime-scan.ts snapshot (id -> real element),
   * checked before the static data-ai/aria-label/text ladder — lets a verb
   * target a dynamically-rendered element (a list row) the manifest never
   * saw. Absent entirely for a caller that hasn't wired up live scanning.
   */
  liveElements?: Map<string, HTMLElement>;
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
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onExplain(verb.text ?? "I know what you need, but I can't find it on this page right now.");
        return;
      }
      highlightElement(el);
      // "open" means make the thing actually appear (a menu, a modal, a
      // panel) — highlighting alone doesn't do that; a real click does.
      if (verb.verb === "open") el.click();
      if (verb.text) options.onExplain(verb.text);
      return;
    }

    case "navigate":
      options.onNavigate?.(verb.route);
      if (verb.text) options.onExplain(verb.text);
      return;

    case "do": {
      const allowed = options.registeredActions ?? [];
      if (allowed.includes(verb.action)) {
        // Explicit, developer-owned path — unchanged.
        options.onDo?.(verb.action, verb.target);
        if (verb.text) options.onExplain(verb.text);
        return;
      }

      // Auto-discovered path: the server already verified `target` names a
      // real element (the static manifest or this exact request's own
      // live-DOM scan) before ever returning this verb — never something
      // the model invented (see resolveVerb in server.ts).
      if (verb.target || verb.apiCall) {
        const el = verb.target ? findElement(verb.target, options.liveElements) : null;
        if (el) {
          // Click-first: the real element's own handler runs in full (any
          // local state update, spinner, or non-network side effect a raw
          // fetch would silently skip), and it's the only way to fire an
          // action that has no fetch/axios call at all — a button that
          // just reveals a form, e.g. — which never gets an `apiCall` in
          // the first place. `apiCall` is only ever the fallback below,
          // for a target that can't be resolved live right now (e.g. it's
          // on a different page) — never fired in addition to a real
          // click, so the action can't run twice.
          highlightElement(el);
          el.click();
          if (verb.text) options.onExplain(verb.text);
          return;
        }
        if (verb.target) (options.onMiss ?? logMiss)({ attempted: verb.target, route });

        if (verb.apiCall) {
          if (verb.text) options.onExplain(verb.text);
          void executeApiCall(verb.apiCall).then((result) => {
            if (!result.ok) {
              options.onExplain("I tried to do that, but something went wrong — try again in a moment.");
            }
          });
          return;
        }
      }

      options.onExplain(verb.text ?? "That action isn't available here.");
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

/**
 * Fires exactly the same request a real click on the target element would
 * already make — same-origin only (apiCall.url is always relative, never a
 * different host), and `credentials: "same-origin"` so the browser attaches
 * the user's own real session cookies, the same way a manual click would.
 * No body is sent: l1-scan.ts's static capture only ever traces method+url,
 * never a request body (which usually depends on runtime state a build-time
 * scan can't see) — fine for the common trigger-style action (an id already
 * baked into the URL, no other payload needed), a real gap for one that
 * requires one.
 */
async function executeApiCall(apiCall: ApiCall): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(apiCall.url, { method: apiCall.method, credentials: "same-origin" });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false };
  }
}

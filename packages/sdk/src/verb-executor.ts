// Turns a raw server response into a UI action — or, on anything that fails
// validation, into a plain explain. This is the client-side half of
// BUILD_PLAN.md invariant #1 ("the LLM never emits code or selectors, only a
// verb from a fixed list") and invariant #3 ("any lookup failure degrades to
// explain — never guess, never wrong-click"). The server (`server.ts`)
// enforces the same schema independently — never trust the client alone.

import { VerbResponseSchema, type ApiCall, type BatchAction, type TourStep, type VerbResponse } from "@cairnvibe/core";
import { dragElement, findElement, findElementWithRetry, fillElement, highlightElement, logMiss, pressKey, readElement, selectOption, waitForDomSettle, type MissContext } from "./element-ladder";
import { moveCursorTo } from "./cursor-overlay";
import { executeWebMcpTool } from "./webmcp-client";

/** The real result of one agent-loop step (click/fill/read/call_tool/
 * navigate, or a batch of several) — fed back to the model as its next
 * turn's "observation" so it can decide what to do next instead of acting
 * blind. The loop that drives this lives on the caller's side, not here:
 * index.tsx's runTypedAgentLoop for the HTTP path, realtime-server.ts's
 * finalizeTurn for the realtime one — this module only ever executes one
 * step (or one batch of steps) at a time. */
export interface ToolStepResult {
  verb: "click" | "fill" | "read" | "call_tool" | "batch" | "navigate" | "drag" | "select" | "key" | "scroll" | "wait_for";
  target?: string;
  ok: boolean;
  observation: string;
}

// wait_for's own real, bounded retry budget — longer than
// findElementWithRetry's own default (2 attempts, 300ms apart, ~300ms
// total), since this verb exists specifically for "I know something
// async should show up" — a toast, a panel appearing after a click — not
// the incidental transient-miss recovery findElementWithRetry's default
// already covers for click/fill/batch steps.
const WAIT_FOR_ATTEMPTS = 6;
const WAIT_FOR_DELAY_MS = 500;

/**
 * Promise wrapper around executeVerbResponse for a continuing verb
 * (click/fill/read/call_tool, or now a navigate marked `continueAfter` —
 * see isTerminalVerb in @cairnvibe/core) — resolves once the real action
 * has actually finished (synchronously for click/fill/read, after a real
 * await for call_tool/navigate) with its real observation, instead of the
 * fire-and-forget callback shape every other verb uses. This is what a
 * loop driver awaits before deciding whether to call the model again.
 * `onNavigate` is only needed for that new navigate-as-continuing-step
 * case — every existing caller that never passes it keeps working
 * unchanged (a continueAfter navigate with no onNavigate here would just
 * never actually move the page; real callers always pass one, same as
 * handleVerb's own options already do for the terminal case).
 */
export function executeToolStep(
  raw: unknown,
  route: string,
  liveElements?: Map<string, HTMLElement>,
  onNavigate?: (route: string) => void,
  onConfirmTool?: (tool: { name: string; description: string }) => Promise<boolean>,
): Promise<ToolStepResult | null> {
  return new Promise((resolve) => {
    // executeVerbResponse only ever reaches onToolStep for a genuinely
    // continuing verb — callers are only expected to call this after
    // already confirming (via isTerminalVerb) that the parsed verb is one,
    // so this should always fire; a real timeout (not an immediate
    // microtask — call_tool's own real network round trip needs the time)
    // is the safety net for the case where it somehow doesn't, so a loop
    // driver awaiting this can never hang forever.
    const timer = setTimeout(() => resolve(null), 15000);
    executeVerbResponse(raw, route, {
      onExplain: () => {},
      liveElements,
      onNavigate,
      onConfirmTool,
      onToolStep: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
    });
  });
}

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
  /** A click/fill/read/call_tool step finished — see ToolStepResult. Only
   * called for the agent loop's continuing verbs, never the terminal ones. */
  onToolStep?: (result: ToolStepResult) => void;
  /** Action ids the customer has actually wired up. "do" is rejected for anything else. */
  registeredActions?: string[];
  /**
   * This turn's frozen runtime-scan.ts snapshot (id -> real element),
   * checked before the static data-ai/aria-label/text ladder — lets a verb
   * target a dynamically-rendered element (a list row) the manifest never
   * saw. Absent entirely for a caller that hasn't wired up live scanning.
   */
  liveElements?: Map<string, HTMLElement>;
  /**
   * Architecture Pillar 6 (the safety layer) — real confirmation for a
   * WebMCP tool whose own registration declared `riskTier: "confirm"`
   * (webmcp-client.ts's own doc comment covers the enforcement point).
   * Absent means every "confirm"-tier tool call is declined by default —
   * the safe fallback for a host app that hasn't wired up a real
   * confirmation UI, never an implicit yes.
   */
  onConfirmTool?: (tool: { name: string; description: string }) => Promise<boolean>;
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
      // The cursor visibly arrives before "open"'s real click fires — the
      // whole point is a user watching sees where it's about to click
      // BEFORE the menu/modal/panel actually opens, not simultaneously.
      void moveCursorTo(el).then(() => {
        // "open" means make the thing actually appear (a menu, a modal, a
        // panel) — highlighting alone doesn't do that; a real click does.
        if (verb.verb === "open") el.click();
        if (verb.text) options.onExplain(verb.text);
      });
      return;
    }

    case "navigate": {
      // Real, live-reported gap this closes: navigate used to ALWAYS end
      // the turn the instant it fired, even for a compound goal like "buy
      // earbuds" that needs navigate, then search, then a real report
      // back — see isTerminalVerb's own doc comment in @cairnvibe/core.
      // `options.onToolStep` is only ever set by executeToolStep's own
      // continuing-step wrapper — handleVerb's options never provide it —
      // so this branch can only run when the caller already confirmed
      // (via isTerminalVerb) that this navigate was genuinely marked
      // continueAfter; the defensive `verb.continueAfter` check here is
      // belt-and-suspenders, not the real gate.
      if (verb.continueAfter && options.onToolStep) {
        if (verb.text) options.onExplain(verb.text);
        options.onNavigate?.(verb.route);
        // A client-side route change is itself an async re-render (a new
        // page's whole DOM mounting) — same real race waitForDomSettle
        // already closes for fill/click, arguably more likely here. The
        // NEXT resolveVerb call needs the settled new page's context, not
        // whatever was on screen the instant router.push was called.
        void waitForDomSettle(300, 200, 2000).then(() => {
          options.onToolStep?.({ verb: "navigate", target: verb.route, ok: true, observation: `Navigated to ${verb.route}.` });
        });
        return;
      }
      options.onNavigate?.(verb.route);
      if (verb.text) options.onExplain(verb.text);
      return;
    }

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
          void moveCursorTo(el).then(() => {
            el.click();
            if (verb.text) options.onExplain(verb.text);
          });
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

    // The agent loop's steps (server.ts's runAgentLoop) — each executes for
    // real and reports a real observation back via onToolStep, instead of
    // ending the turn the way every verb above does. `target` for these
    // always came from the manifest/currentPageElements/liveElements this
    // exact turn showed the model — never invented, same invariant as do.
    case "click": {
      if (verb.text) options.onExplain(verb.text);
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "click", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      highlightElement(el);
      void moveCursorTo(el).then(() => {
        el.click();
        // Real, live-found race this closes — see waitForDomSettle's own
        // doc comment: a click can trigger an async re-render (a cart count
        // updating, a filtered list refreshing) that hasn't happened yet the
        // instant .click() returns. A subsequent read step in the same turn
        // needs the SETTLED result, not whatever was on screen a moment ago.
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "click", target: verb.target, ok: true, observation: "Clicked it." });
        });
      });
      return;
    }

    case "fill": {
      if (verb.text) options.onExplain(verb.text);
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "fill", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      highlightElement(el);
      // fillElement itself is both the "is this a real form field" check
      // AND the commit (it sets the value the instant it returns true) —
      // deliberately called from inside this .then(), not the synchronous
      // miss-check above, so the cursor is genuinely seen arriving BEFORE
      // any text appears, not simultaneously with it.
      void moveCursorTo(el).then(() => {
        if (!fillElement(el, verb.value)) {
          (options.onMiss ?? logMiss)({ attempted: verb.target, route });
          options.onToolStep?.({ verb: "fill", target: verb.target, ok: false, observation: "That element isn't a real form field — can't type into it." });
          return;
        }
        // See the click case's own comment — the exact real bug found live:
        // typing into a search box, then reading the still-unfiltered
        // results a moment later and reporting a match the real, since-
        // filtered page never actually showed.
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "fill", target: verb.target, ok: true, observation: `Typed "${verb.value}" into it.` });
        });
      });
      return;
    }

    case "read": {
      if (verb.text) options.onExplain(verb.text);
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "read", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      // No mutation here, but the cursor still visits what's being read —
      // real visual proof of what the agent is actually looking at, not
      // just a claim in the eventual reported observation.
      void moveCursorTo(el).then(() => {
        options.onToolStep?.({ verb: "read", target: verb.target, ok: true, observation: readElement(el) });
      });
      return;
    }

    case "call_tool": {
      if (verb.text) options.onExplain(verb.text);
      void executeWebMcpTool(verb.name, verb.args, options.onConfirmTool).then((result) => {
        options.onToolStep?.({ verb: "call_tool", target: verb.name, ok: result.ok, observation: result.observation });
      });
      return;
    }

    case "drag": {
      if (verb.text) options.onExplain(verb.text);
      const from = findElement(verb.target, options.liveElements);
      const to = from ? findElement(verb.to, options.liveElements) : null;
      if (!from || !to) {
        (options.onMiss ?? logMiss)({ attempted: from ? verb.to : verb.target, route });
        options.onToolStep?.({ verb: "drag", target: verb.target, ok: false, observation: from ? "Could not find the drop destination on the page." : "Could not find that element on the page." });
        return;
      }
      highlightElement(from);
      void moveCursorTo(from).then(() => {
        dragElement(from, to);
        // The cursor also glides to the drop point — fire-and-forget, not
        // awaited, since it's purely a visual echo of a drag that already
        // happened via real pointer events; nothing downstream depends on
        // it finishing.
        void moveCursorTo(to);
        // Same real re-render race as click/fill — a drop can trigger an
        // async re-render (a canvas connection line, a reordered list) that
        // hasn't settled the instant the pointer sequence finishes.
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "drag", target: verb.target, ok: true, observation: `Dragged it to ${verb.to}.` });
        });
      });
      return;
    }

    case "select": {
      if (verb.text) options.onExplain(verb.text);
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "select", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      highlightElement(el);
      // Same reasoning as fill's own comment — selectOption is both the
      // "does a matching option exist" check and the commit, so it's called
      // from inside this .then(), after the cursor genuinely arrives.
      void moveCursorTo(el).then(() => {
        if (!selectOption(el, verb.value)) {
          (options.onMiss ?? logMiss)({ attempted: verb.target, route });
          options.onToolStep?.({ verb: "select", target: verb.target, ok: false, observation: `Could not find an option matching "${verb.value}".` });
          return;
        }
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "select", target: verb.target, ok: true, observation: `Selected "${verb.value}".` });
        });
      });
      return;
    }

    case "key": {
      if (verb.text) options.onExplain(verb.text);
      const el = verb.target ? findElement(verb.target, options.liveElements) : (document.activeElement as HTMLElement | null);
      if (!el) {
        if (verb.target) (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "key", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      const afterMove = () => {
        pressKey(el, verb.key);
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "key", target: verb.target, ok: true, observation: `Pressed ${verb.key}.` });
        });
      };
      // With no explicit target ("whatever's currently focused"), there's
      // nothing sensible for the cursor to glide to — call straight through
      // instead of routing through a promise callback for no reason, so
      // this path stays exactly as synchronous as it always was.
      if (verb.target) {
        void moveCursorTo(el).then(afterMove);
      } else {
        afterMove();
      }
      return;
    }

    case "scroll": {
      if (verb.text) options.onExplain(verb.text);
      const el = findElement(verb.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: verb.target, route });
        options.onToolStep?.({ verb: "scroll", target: verb.target, ok: false, observation: "Could not find that element on the page." });
        return;
      }
      // A real, already-known element (never a coordinate or something
      // not yet discovered) — highlightElement's own scrollIntoView is
      // exactly the real repositioning this verb exists for; the glow
      // also gives the user a visible cue of where the agent just moved.
      highlightElement(el);
      void moveCursorTo(el).then(() => {
        void waitForDomSettle().then(() => {
          options.onToolStep?.({ verb: "scroll", target: verb.target, ok: true, observation: "Scrolled it into view." });
        });
      });
      return;
    }

    case "wait_for": {
      if (verb.text) options.onExplain(verb.text);
      void findElementWithRetry(verb.target, options.liveElements, WAIT_FOR_ATTEMPTS, WAIT_FOR_DELAY_MS).then((el) => {
        if (!el) {
          (options.onMiss ?? logMiss)({ attempted: verb.target, route });
          options.onToolStep?.({ verb: "wait_for", target: verb.target, ok: false, observation: "It never appeared." });
          return;
        }
        void moveCursorTo(el).then(() => {
          options.onToolStep?.({ verb: "wait_for", target: verb.target, ok: true, observation: "It appeared." });
        });
      });
      return;
    }

    // Several click/fill/read/call_tool steps in one round trip instead of
    // one each — server.ts's resolveVerb already validated every action's
    // target/name against real state before this ever arrived. Runs in
    // order (never parallel — a later step may depend on an earlier one's
    // DOM change) and stops at the first failure, reporting one combined
    // observation back — a batch that stops partway is still a real,
    // informative result for the model's next turn, not a silent partial
    // success.
    case "batch": {
      if (verb.text) options.onExplain(verb.text);
      void executeBatchActions(verb.actions, route, options).then((result) => {
        options.onToolStep?.({ verb: "batch", ok: result.ok, observation: result.observation });
      });
      return;
    }
  }
}

async function executeBatchActions(
  actions: BatchAction[],
  route: string,
  options: VerbExecutorOptions,
): Promise<{ ok: boolean; observation: string }> {
  const steps: string[] = [];
  for (const action of actions) {
    const result = await executeOneBatchAction(action, route, options);
    const label = ("target" in action && action.target) || ("name" in action && action.name) || "(focused element)";
    steps.push(`${action.verb} ${label}: ${result.observation}`);
    if (!result.ok) return { ok: false, observation: steps.join(" | ") };
  }
  return { ok: true, observation: steps.join(" | ") };
}

// Phase 3 step 4 — real, bounded, LLM-free retry latitude for the
// Executor's own lookups (CODA's own point: the Executor stays
// opinion-free; anything requiring judgment escalates to the Critic,
// which now genuinely exists as of step 3). Scoped to batch specifically,
// per the plan's own build order — a batch's later steps are the ones
// most likely to race a DOM update the batch's OWN earlier step just
// triggered, which is exactly the "stale re-render" case this recovers
// from; single-step click/fill/read stay unchanged (findElement, no
// retry) rather than widening scope beyond what was actually planned.
async function executeOneBatchAction(action: BatchAction, route: string, options: VerbExecutorOptions): Promise<{ ok: boolean; observation: string }> {
  switch (action.verb) {
    case "click": {
      const el = await findElementWithRetry(action.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      highlightElement(el);
      await moveCursorTo(el);
      el.click();
      // Same real race as the single-step case (see waitForDomSettle's own
      // doc comment) — arguably MORE likely here, since a batch's next
      // step often deliberately reads what THIS step just changed.
      await waitForDomSettle();
      return { ok: true, observation: "Clicked it." };
    }
    case "fill": {
      const el = await findElementWithRetry(action.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      highlightElement(el);
      // See the single-step fill case's own comment — fillElement is both
      // the field-type check and the commit, called after the cursor
      // genuinely arrives rather than in the synchronous miss-check.
      await moveCursorTo(el);
      if (!fillElement(el, action.value)) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "That element isn't a real form field — can't type into it." };
      }
      await waitForDomSettle();
      return { ok: true, observation: `Typed "${action.value}" into it.` };
    }
    case "read": {
      const el = await findElementWithRetry(action.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      await moveCursorTo(el);
      return { ok: true, observation: readElement(el) };
    }
    case "call_tool": {
      const result = await executeWebMcpTool(action.name, action.args, options.onConfirmTool);
      return { ok: result.ok, observation: result.observation };
    }
    case "drag": {
      const from = await findElementWithRetry(action.target, options.liveElements);
      const to = from ? await findElementWithRetry(action.to, options.liveElements) : null;
      if (!from || !to) {
        (options.onMiss ?? logMiss)({ attempted: from ? action.to : action.target, route });
        return { ok: false, observation: from ? "Could not find the drop destination on the page." : "Could not find that element on the page." };
      }
      highlightElement(from);
      await moveCursorTo(from);
      dragElement(from, to);
      void moveCursorTo(to); // visual echo of the drop point — not awaited, purely decorative
      await waitForDomSettle();
      return { ok: true, observation: `Dragged it to ${action.to}.` };
    }
    case "select": {
      const el = await findElementWithRetry(action.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      highlightElement(el);
      await moveCursorTo(el);
      if (!selectOption(el, action.value)) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: `Could not find an option matching "${action.value}".` };
      }
      await waitForDomSettle();
      return { ok: true, observation: `Selected "${action.value}".` };
    }
    case "key": {
      const el = action.target ? await findElementWithRetry(action.target, options.liveElements) : (document.activeElement as HTMLElement | null);
      if (!el) {
        if (action.target) (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      if (action.target) await moveCursorTo(el);
      pressKey(el, action.key);
      await waitForDomSettle();
      return { ok: true, observation: `Pressed ${action.key}.` };
    }
    case "scroll": {
      const el = await findElementWithRetry(action.target, options.liveElements);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "Could not find that element on the page." };
      }
      highlightElement(el);
      await moveCursorTo(el);
      await waitForDomSettle();
      return { ok: true, observation: "Scrolled it into view." };
    }
    case "wait_for": {
      const el = await findElementWithRetry(action.target, options.liveElements, WAIT_FOR_ATTEMPTS, WAIT_FOR_DELAY_MS);
      if (!el) {
        (options.onMiss ?? logMiss)({ attempted: action.target, route });
        return { ok: false, observation: "It never appeared." };
      }
      await moveCursorTo(el);
      return { ok: true, observation: "It appeared." };
    }
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

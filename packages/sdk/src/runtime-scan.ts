// A live inventory of what's actually clickable on screen right now — not
// the build-time manifest, and not limited to elements a developer
// remembered to tag with data-ai. This is what lets the agent address a
// dynamically-rendered row (a session card, a list item) it was never told
// about ahead of time. Deliberately narrow in what counts as "interactive":
// the same semantic-clickable set element-ladder.ts's own fallback search
// already uses, plus anything carrying data-ai — a plain `<div onClick>`
// with no semantic role is invisible to this, same limit the existing
// ladder already has.

import type { LiveElement } from "@cairnvibe/core";

// Clickable elements, plus real fillable form fields (text/email/number/etc
// inputs, textarea, select — NOT submit/button inputs, already covered by
// the plain "button" role below) — the agent loop's fill/read steps need
// these to be discoverable the same way a click target already is.
const CANDIDATE_SELECTOR =
  "[data-ai], button, a, [role='button'], input[type='submit'], input[type='button'], " +
  "input:not([type='submit']):not([type='button']):not([type='hidden']), textarea, select";
// Bumped from 40 now that off-screen candidates (see viewportDistance below)
// compete for a slot too — still comfortably under CopilotRequestSchema's
// liveElements cap (60) server-side.
const MAX_ELEMENTS = 50;
const MAX_LABEL_LENGTH = 80;
const RESCAN_DEBOUNCE_MS = 250;

export interface LiveScan {
  elements: LiveElement[];
  byId: Map<string, HTMLElement>;
}

/** Excludes elements that aren't rendered anywhere (display:none, a closed
 * modal's contents, an inactive tab panel) — these get an all-zero rect from
 * getBoundingClientRect() in every real browser, unlike anything actually on
 * the page, however far off-screen. Not the same question as "is this
 * scrolled into view" (viewportDistance, below) — this is "does it exist on
 * the page at all right now." */
function isRendered(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

/**
 * 0 for anything already in the viewport; otherwise the pixel gap to the
 * nearest edge, summed across both axes. Used to RANK candidates instead of
 * hard-filtering them — an element below the fold or in an unscrolled
 * carousel is still real and still actionable (highlightElement already
 * scrolls to it before acting on it), the agent just couldn't discover it
 * existed under the old viewport-only scan. Ranking keeps what's on screen
 * right now winning every tie, while still surfacing what's just out of
 * view when there's room under MAX_ELEMENTS.
 */
function viewportDistance(el: Element): number {
  const rect = el.getBoundingClientRect();
  const verticalGap = rect.top > window.innerHeight ? rect.top - window.innerHeight : rect.bottom < 0 ? -rect.bottom : 0;
  const horizontalGap = rect.left > window.innerWidth ? rect.left - window.innerWidth : rect.right < 0 ? -rect.right : 0;
  return verticalGap + horizontalGap;
}

/** A form field's own text content is always empty — its identity comes
 * from an associated <label>, a placeholder, or its name attribute
 * instead, in that order of how a real user would recognize the field. */
function formFieldLabel(el: HTMLElement): string {
  if (el.id) {
    const labelled = el.ownerDocument?.querySelector(`label[for="${cssEscapeId(el.id)}"]`);
    if (labelled?.textContent?.trim()) return labelled.textContent;
  }
  const wrappingLabel = el.closest("label");
  if (wrappingLabel?.textContent?.trim()) return wrappingLabel.textContent;
  return el.getAttribute("placeholder") || el.getAttribute("name") || "";
}

function cssEscapeId(id: string): string {
  return id.replace(/["\\]/g, "\\$&");
}

// tagName, not instanceof — see element-ladder.ts's isFormField for why.
function isFormField(el: HTMLElement): boolean {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

function labelFor(el: HTMLElement): string {
  const raw = el.getAttribute("aria-label") || (isFormField(el) ? formFieldLabel(el) : el.textContent) || "";
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length > MAX_LABEL_LENGTH ? `${trimmed.slice(0, MAX_LABEL_LENGTH - 1)}…` : trimmed;
}

function roleFor(el: HTMLElement): string {
  if (el.getAttribute("role")) return el.getAttribute("role")!;
  if (isFormField(el)) return "input";
  return el.tagName.toLowerCase();
}

/**
 * Scans the live DOM for interactive elements, on screen right now or just
 * off it (see viewportDistance) — anything rendered on the page at all, not
 * just what's currently scrolled into view. Returns both the bounded list to
 * send to the model (`elements`, capped at MAX_ELEMENTS and
 * MAX_LABEL_LENGTH — the actual privacy/payload backstop, mirrored
 * server-side in CopilotRequestSchema) and the real elements it maps to,
 * keyed by the same ids (`byId`) — resolve a verb's target by looking it up
 * here, never by re-deriving a selector from the id string.
 */
export function scanInteractiveElements(root: ParentNode = document): LiveScan {
  const elements: LiveElement[] = [];
  const byId = new Map<string, HTMLElement>();
  let counter = 0;

  if (typeof document === "undefined") return { elements, byId };

  const candidates = Array.from(root.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR)).filter(isRendered);
  candidates.sort((a, b) => viewportDistance(a) - viewportDistance(b));

  for (const el of candidates) {
    if (elements.length >= MAX_ELEMENTS) break;

    const dataAi = el.getAttribute("data-ai");
    const id = dataAi ?? `live-${counter++}`;
    if (byId.has(id)) continue; // a data-ai id already covered by an earlier match

    const label = labelFor(el);
    if (!label) continue; // nothing to address it by — skip rather than send an empty label

    byId.set(id, el);
    elements.push({ id, role: roleFor(el), label });
  }

  return { elements, byId };
}

export interface LiveElementRegistry {
  /** Starts continuous background scanning — call once, typically on mount. */
  start(): void;
  stop(): void;
  /**
   * Freezes the current scan for one request/response round trip. Call
   * this once when a question is sent, and resolve that turn's verb
   * against exactly this snapshot — not a fresh call — so a background
   * rescan that lands mid-flight can't shift what an id resolves to
   * between when the request went out and when the response comes back.
   */
  getSnapshot(): LiveScan;
}

/**
 * Keeps a scan continuously fresh in the background via a debounced
 * MutationObserver (plus scroll/resize, since viewport membership changes
 * without any DOM mutation) instead of only scanning at the moment a
 * question is asked — so the agent never has to pause to "go look at the
 * page" right when it needs to click something; a sub-agent gathering
 * context while the main conversation keeps moving.
 */
export function createLiveElementRegistry(): LiveElementRegistry {
  let current: LiveScan = { elements: [], byId: new Map() };
  let observer: MutationObserver | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function rescan() {
    current = scanInteractiveElements();
  }

  function scheduleRescan() {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      rescan();
    }, RESCAN_DEBOUNCE_MS);
  }

  function start() {
    if (typeof document === "undefined" || observer) return;
    rescan();
    observer = new MutationObserver(scheduleRescan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-ai", "aria-label"],
    });
    window.addEventListener("scroll", scheduleRescan, { passive: true });
    window.addEventListener("resize", scheduleRescan);
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    window.removeEventListener("scroll", scheduleRescan);
    window.removeEventListener("resize", scheduleRescan);
  }

  function getSnapshot(): LiveScan {
    return current;
  }

  return { start, stop, getSnapshot };
}

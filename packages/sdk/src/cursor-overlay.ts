// A visible, animated synthetic cursor that glides to whatever element the
// agent is about to act on, and genuinely arrives — before anything actually
// happens on screen — rather than a click just occurring with no visible
// lead-up. Real, watchable proof of what the agent resolved, the same way
// watching a person's own mouse move tells you where they're about to click
// before it happens; matches this SDK's own "verified, not trusted"
// discipline in a form a user can literally see, not just read.
//
// Purely additive and deliberately decoupled from highlightElement
// (element-ladder.ts) — that function's own scroll+glow behavior is
// unchanged and still called by every site that used it before. This module
// only adds the moving cursor itself; a caller awaits moveCursorTo(el)
// before firing the real action so the cursor is seen arriving first, never
// after the fact — see verb-executor.ts's own call sites for the exact
// sequencing.

const CURSOR_ID = "cairn-cursor";
const MOVE_MS = 550;
const ARRIVE_PAUSE_MS = 160;
// The CSS side already disables the cursor's transition/animation under
// prefers-reduced-motion (see #cairn-cursor in the injected <style> block),
// which makes it jump instead of glide — but without this, the real delay
// before the action fires would stay the full ~710ms even though there's
// nothing left to watch. Mirrors the visual change with a real timing one.
const REDUCED_MOVE_MS = 60;
const REDUCED_ARRIVE_PAUSE_MS = 40;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Module-scope, not per-call — the whole point is a SINGLE cursor that
// glides from wherever it last was, the way a real mouse never teleports
// between two unrelated screen positions.
let lastX: number | null = null;
let lastY: number | null = null;

function ensureCursorEl(): HTMLElement | null {
  if (typeof document === "undefined" || !document.body) return null;
  let el = document.getElementById(CURSOR_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = CURSOR_ID;
  el.setAttribute("aria-hidden", "true");
  // A simple filled pointer shape — matches the widget's own ember accent,
  // with a thin dark stroke so it reads clearly on light AND dark pages
  // (the host app's own background is never something this SDK controls).
  el.innerHTML =
    '<svg width="22" height="22" viewBox="0 0 22 22" fill="none" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M2 1.5 L2 18.2 L6.3 14.4 L9.1 20.6 L11.7 19.4 L8.9 13.3 L14.6 13.1 Z" fill="#E07A3F" stroke="#1B1815" stroke-width="1.1" stroke-linejoin="round"/>' +
    "</svg>";
  el.style.cssText =
    "position:fixed;left:0;top:0;z-index:2147483001;pointer-events:none;opacity:0;transition:opacity 180ms ease;will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.35));";
  document.body.appendChild(el);
  return el;
}

/**
 * Animates the synthetic cursor to `el`'s center and resolves once it has
 * genuinely arrived (plus a brief real hover pause) — callers await this
 * BEFORE performing the real action, so the cursor is seen gliding there
 * first. Deliberately timer-driven (`window.setTimeout`), not
 * `transitionend`/`Element.animate().finished`-driven — this repo's test
 * environment is plain Node, not a real browser (see waitForDomSettle's own
 * doc comment for the same discipline), and a fixed, known duration is what
 * makes this testable with fake timers instead of needing real animation-
 * completion events that a headless/no-DOM environment may never fire.
 *
 * SSR/no-DOM safe — same defensive guard `waitForDomSettle` already uses —
 * so a caller never needs its own environment check before calling this.
 */
export function moveCursorTo(el: HTMLElement): Promise<void> {
  if (typeof document === "undefined" || typeof window === "undefined" || typeof el.getBoundingClientRect !== "function") {
    return Promise.resolve();
  }
  const cursor = ensureCursorEl();
  if (!cursor) return Promise.resolve();

  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  if (lastX === null || lastY === null) {
    // The very first move of the session starts from the widget's own
    // corner (bottom-right, where the FAB lives) instead of materializing
    // at (0,0) — reads as "coming from Cairn," not appearing from nowhere.
    lastX = window.innerWidth - 40;
    lastY = window.innerHeight - 40;
    cursor.style.transform = `translate(${lastX}px, ${lastY}px)`;
  }

  const reduced = prefersReducedMotion();
  const moveMs = reduced ? REDUCED_MOVE_MS : MOVE_MS;
  const arrivePauseMs = reduced ? REDUCED_ARRIVE_PAUSE_MS : ARRIVE_PAUSE_MS;

  cursor.style.transition = `transform ${moveMs}ms cubic-bezier(.4,0,.2,1), opacity 180ms ease`;
  cursor.style.opacity = "1";
  // Forces a style flush so the browser animates FROM the current position
  // TO the new one instead of jumping straight there — reading a layout
  // property is the standard, harmless way to force this without a real
  // animation API (which, per this function's own doc comment, this
  // deliberately avoids depending on for its completion signal anyway).
  void cursor.offsetHeight;
  cursor.style.transform = `translate(${x}px, ${y}px)`;
  lastX = x;
  lastY = y;

  return new Promise((resolve) => {
    window.setTimeout(() => {
      cursor.classList.add("cairn-cursor-hover");
      window.setTimeout(() => {
        cursor.classList.remove("cairn-cursor-hover");
        resolve();
      }, arrivePauseMs);
    }, moveMs);
  });
}

/** Fades the synthetic cursor out — called once the widget itself closes or
 * unmounts, so it doesn't sit visible on screen after the conversation
 * ends. Safe to call even if the cursor was never created. */
export function hideCursor(): void {
  if (typeof document === "undefined") return;
  const el = document.getElementById(CURSOR_ID);
  if (el) el.style.opacity = "0";
}

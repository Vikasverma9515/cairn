// The Element Ladder (BUILD_PLAN.md invariant #3): a lookup failure must
// degrade to explain-only, never guess and click the wrong thing.
//
//   0. liveElements map  — a runtime-scan.ts snapshot, when the caller has
//      one: the id came from real elements the browser itself found this
//      turn (a dynamically-rendered row with no data-ai included), so an
//      exact map lookup is both the fastest and the most trustworthy path.
//   1. data-ai="..."     — exact, authoritative
//   2. aria-label / role — accessible-name fallback
//   3. visible text      — last resort, exact then substring match
//   4. FAIL               — caller degrades to explain + logs the miss

export function findElement(target: string, liveElements?: Map<string, HTMLElement>): HTMLElement | null {
  const live = liveElements?.get(target);
  if (live) return live;

  if (typeof document === "undefined") return null;

  const byDataAi = document.querySelector<HTMLElement>(`[data-ai="${cssEscape(target)}"]`);
  if (byDataAi) return byDataAi;

  const byAriaLabel = document.querySelector<HTMLElement>(`[aria-label="${cssEscape(target)}"]`);
  if (byAriaLabel) return byAriaLabel;

  const byRole = document.querySelector<HTMLElement>(`[role="${cssEscape(target)}"]`);
  if (byRole) return byRole;

  const candidates = document.querySelectorAll<HTMLElement>(
    "button, a, [role='button'], input[type='submit'], input[type='button']",
  );
  const normalizedTarget = normalize(target);

  for (const el of Array.from(candidates)) {
    if (normalize(el.textContent ?? "") === normalizedTarget) return el;
  }
  for (const el of Array.from(candidates)) {
    if (normalize(el.textContent ?? "").includes(normalizedTarget)) return el;
  }

  return null;
}

/**
 * Phase 3 step 4 (see DEVELOPMENT.md/the plan file) — CODA's own point:
 * the Executor gets real local retry latitude for a genuinely MECHANICAL
 * miss (a re-render replaced the DOM node the frozen liveElements snapshot
 * pointed at; an animation/async render hadn't settled yet) before a
 * failure escalates all the way to the Critic/a replan. Deliberately NOT
 * a second LLM call — the Executor stays opinion-free, exactly re-running
 * the SAME real lookup (which, past the liveElements-map check, already
 * queries the LIVE DOM directly — a stale snapshot doesn't matter to that
 * part) after a short real wait. A target that's genuinely not on the
 * page still fails after `attempts`, surfacing as a real miss — this
 * never silently invents success.
 */
export async function findElementWithRetry(
  target: string,
  liveElements?: Map<string, HTMLElement>,
  attempts = 2,
  delayMs = 300,
): Promise<HTMLElement | null> {
  for (let i = 0; i < attempts; i++) {
    const el = findElement(target, liveElements);
    if (el) return el;
    if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Real, live-found bug this closes: a `fill`/`click` step reported itself
 * "done" the instant its DOM event was dispatched — but the app's own
 * reaction to that event (a filtered search-results grid re-rendering, a
 * cart count updating) can be an unbounded-latency async round trip (a
 * Next.js App Router `router.push` re-fetching a server component, for
 * example — not a fixed debounce with a known delay to just sleep past).
 * A `read` step immediately after saw STALE content and the agent
 * confidently reported findings that didn't match what the page actually,
 * eventually, showed — confirmed live: typing "book" into a search box,
 * then reading the still-unfiltered product grid a moment later, and
 * reporting a match ("Novel: The Long Way") the REAL, since-filtered page
 * went on to show zero results for.
 *
 * Waits for real DOM mutations instead of guessing a sleep duration: if
 * nothing starts mutating within `initialWaitMs`, resolves immediately
 * (the action had no async effect at all — no reason to add latency to
 * the common case); once mutations start, waits for `quietMs` of no
 * further mutations before considering the page settled; a hard
 * `timeoutMs` ceiling means a page that never stops mutating (an
 * animation, a polling widget) can't stall the agent loop forever.
 */
export function waitForDomSettle(initialWaitMs = 100, quietMs = 200, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    // Real gap this closes: some callers stub a partial `document` (real
    // tests in this repo do exactly that for other reasons — a fake
    // WebMCP-tool document, for instance) without the rest of the DOM API
    // surface — checking `document` alone isn't enough to guarantee
    // MutationObserver (or document.body) actually exist too.
    if (typeof document === "undefined" || typeof MutationObserver === "undefined" || !document.body) {
      resolve();
      return;
    }
    let settled = false;
    let sawMutation = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardCap);
      resolve();
    };

    const observer = new MutationObserver(() => {
      sawMutation = true;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });

    const hardCap = setTimeout(finish, timeoutMs);

    setTimeout(() => {
      if (!sawMutation) finish(); // the action had no async effect — nothing to wait for
    }, initialWaitMs);
  });
}

export function highlightElement(el: HTMLElement, glowMs = 4000): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("cairn-glow");
  window.setTimeout(() => el.classList.remove("cairn-glow"), glowMs);
}

// tagName, not `instanceof HTMLInputElement` — avoids depending on those
// classes existing as globals at all (they don't in a plain Node test
// environment, only a real browser/jsdom), and tagName is exactly what
// distinguishes a real form field regardless.
function isFormField(el: HTMLElement): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

/**
 * Sets a real form field's value AND makes the framework that owns it (React,
 * almost always, in this SDK's own target apps) actually notice — directly
 * assigning `.value` bypasses React's tracked setter, so its own onChange
 * never fires and the app's state silently doesn't update, a well-known
 * React quirk. Going through the *native* prototype's value setter before
 * dispatching a real "input" event is what makes React's synthetic event
 * system pick it up the same way a real keystroke would.
 */
export function fillElement(el: HTMLElement, value: string): boolean {
  if (!isFormField(el)) return false;

  const ctorByTag: Record<string, unknown> = typeof window !== "undefined" ? { INPUT: window.HTMLInputElement, TEXTAREA: window.HTMLTextAreaElement, SELECT: window.HTMLSelectElement } : {};
  const ctor = ctorByTag[el.tagName] as { prototype: object } | undefined;
  const nativeSetter = ctor && (Object.getOwnPropertyDescriptor(ctor.prototype, "value")?.set as ((this: HTMLElement, v: string) => void) | undefined);
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

/** The real current value/text of an element — a form field's `.value`,
 * otherwise its trimmed visible text, bounded the same way runtime-scan.ts
 * bounds a live element's label (this is what the agent loop "observes"
 * after a read step, so it needs the same payload/privacy discipline). */
export function readElement(el: HTMLElement): string {
  const raw = isFormField(el) ? el.value : (el.textContent ?? "");
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length > 500 ? `${trimmed.slice(0, 499)}…` : trimmed || "(empty)";
}

/**
 * Chooses a real `<option>` by its visible text — never a raw internal
 * `value` the model could never actually see. Native `<select>` gets the
 * direct path (set `.value` to the matching option's own value, then fire
 * the same input/change pair fillElement uses so React notices). A custom
 * listbox/combobox (role="listbox"/"option" — Radix, Headless UI, etc.)
 * has no real `<option>` to set, so the fallback clicks the matching
 * option-shaped descendant instead, the same "do the real user gesture"
 * principle the do/click cases already follow.
 */
export function selectOption(el: HTMLElement, visibleText: string): boolean {
  if (el.tagName === "SELECT") {
    const select = el as HTMLSelectElement;
    const match = Array.from(select.options).find((o) => normalize(o.textContent ?? "") === normalize(visibleText)) ?? Array.from(select.options).find((o) => normalize(o.textContent ?? "").includes(normalize(visibleText)));
    if (!match) return false;
    select.value = match.value;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  const candidates = el.querySelectorAll<HTMLElement>('[role="option"], option, li, [role="menuitem"]');
  const match = Array.from(candidates).find((c) => normalize(c.textContent ?? "") === normalize(visibleText)) ?? Array.from(candidates).find((c) => normalize(c.textContent ?? "").includes(normalize(visibleText)));
  if (!match) return false;
  match.click();
  return true;
}

/**
 * A real multi-point pointer-event sequence — pointerdown on `from`'s
 * center, several pointermove steps toward `to`'s center, pointerup on
 * `to` — the same technique a real mouse drag produces, for canvas/kanban/
 * sortable-list libraries (react-dnd, dnd-kit, n8n's own node canvas) that
 * listen for pointer events rather than a single synthetic "drop". Mouse
 * events are fired alongside (same coordinates) for the older libraries
 * that still only listen for those. jsdom's getBoundingClientRect returns
 * all-zero rects with no real layout engine — fine here, since what matters
 * for a test is that the sequence fires with consistent coordinates, not
 * that they reflect real pixels.
 */
export function dragElement(from: HTMLElement, to: HTMLElement, steps = 5): void {
  const fromRect = from.getBoundingClientRect();
  const toRect = to.getBoundingClientRect();
  const fromX = fromRect.left + fromRect.width / 2;
  const fromY = fromRect.top + fromRect.height / 2;
  const toX = toRect.left + toRect.width / 2;
  const toY = toRect.top + toRect.height / 2;

  const fire = (target: HTMLElement, type: string, x: number, y: number) => {
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: typeof window !== "undefined" ? window : undefined };
    if (typeof PointerEvent !== "undefined") target.dispatchEvent(new PointerEvent(type.replace("mouse", "pointer"), opts));
    target.dispatchEvent(new MouseEvent(type, opts));
  };

  fire(from, "mousedown", fromX, fromY);
  for (let i = 1; i <= steps; i++) {
    const x = fromX + ((toX - fromX) * i) / steps;
    const y = fromY + ((toY - fromY) * i) / steps;
    fire(i === steps ? to : from, "mousemove", x, y);
  }
  fire(to, "mouseup", toX, toY);
}

const KEYS_WITH_PRINTABLE_CHAR = new Set(["Enter", "Tab"]);

/**
 * Presses one real key on a target element — focuses it first (a real
 * keypress always lands on whatever's focused; a component that reacts to
 * Escape/Enter/arrows almost always keys off document-level or its own
 * focus-scoped listener, so focus has to be real before the event fires).
 * Fires keydown/keyup (and keypress only for the handful of keys that
 * still expect one — Enter/Tab — matching a real browser's own behavior,
 * which no longer fires keypress for pure navigation keys like arrows).
 */
export function pressKey(el: HTMLElement, key: string): void {
  if (typeof el.focus === "function") el.focus();
  const opts = { bubbles: true, cancelable: true, key };
  el.dispatchEvent(new KeyboardEvent("keydown", opts));
  if (KEYS_WITH_PRINTABLE_CHAR.has(key)) el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
}

export interface MissContext {
  attempted: string;
  route: string;
}

const MISS_LOG_KEY = "cairn:misses";
const MISS_LOG_LIMIT = 200;

export function logMiss(context: MissContext): void {
  try {
    const existingRaw = window.localStorage.getItem(MISS_LOG_KEY);
    const existing: (MissContext & { at: string })[] = existingRaw ? JSON.parse(existingRaw) : [];
    existing.push({ ...context, at: new Date().toISOString() });
    window.localStorage.setItem(MISS_LOG_KEY, JSON.stringify(existing.slice(-MISS_LOG_LIMIT)));
  } catch {
    // localStorage unavailable (SSR, private mode, quota) — never let logging break the UI.
  }
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}

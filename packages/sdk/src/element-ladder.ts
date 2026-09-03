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

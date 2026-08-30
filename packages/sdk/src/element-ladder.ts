// The 4-step Element Ladder (BUILD_PLAN.md invariant #3): a lookup failure
// must degrade to explain-only, never guess and click the wrong thing.
//
//   1. data-ai="..."     — exact, authoritative
//   2. aria-label / role — accessible-name fallback
//   3. visible text      — last resort, exact then substring match
//   4. FAIL               — caller degrades to explain + logs the miss

export function findElement(target: string): HTMLElement | null {
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

export function highlightElement(el: HTMLElement, glowMs = 4000): void {
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.add("cairn-glow");
  window.setTimeout(() => el.classList.remove("cairn-glow"), glowMs);
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

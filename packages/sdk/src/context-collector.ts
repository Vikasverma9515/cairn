// Collects the minimal, privacy-conscious context the runtime sends to
// /api/copilot: the current route (passed in separately by the caller) and
// the ids of interactive elements currently visible in the viewport. Never
// sends full DOM, page text, or anything not covered by `data-ai`.

export function collectVisible(): string[] {
  if (typeof document === "undefined" || typeof window === "undefined") return [];

  const elements = document.querySelectorAll<HTMLElement>("[data-ai]");
  const ids: string[] = [];

  elements.forEach((el) => {
    const rect = el.getBoundingClientRect();
    const inViewport = rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    if (!inViewport) return;
    const id = el.getAttribute("data-ai");
    if (id) ids.push(id);
  });

  return ids;
}

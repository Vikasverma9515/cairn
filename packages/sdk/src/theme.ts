// Theme detection for the widget: follow the host page instead of forcing one look.

/** Parses "rgb(r, g, b)" / "rgba(r, g, b, a)" (what getComputedStyle returns). Null for transparent or unparseable. */
export function parseCssColor(value: string | null | undefined): { r: number; g: number; b: number; a: number } | null {
  if (!value) return null;
  const m = /rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)(?:[\s,/]+(\d*\.?\d+%?))?\s*\)/i.exec(value);
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a };
}

/** Relative luminance below the midpoint counts as a dark background. */
export function isDarkColor(color: { r: number; g: number; b: number }): boolean {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b) < 0.18;
}

/**
 * Is the host page dark? Checks, in order: an explicit dark/light class or data-theme on <html>/<body>,
 * the first opaque background colour on body then html (a dark app with no class is still dark), and
 * finally the OS preference. Never throws (returns false on the server).
 */
export function detectHostDark(doc: Document | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!doc || typeof window === "undefined") return false;
  try {
    for (const el of [doc.documentElement, doc.body]) {
      if (!el) continue;
      const cls = el.className && typeof el.className === "string" ? el.className : "";
      const attr = `${el.getAttribute("data-theme") ?? ""} ${el.getAttribute("data-mode") ?? ""}`;
      if (/(^|\s)dark(\s|$)/i.test(`${cls} ${attr}`)) return true;
      if (/(^|\s)light(\s|$)/i.test(`${cls} ${attr}`)) return false;
    }
    for (const el of [doc.body, doc.documentElement]) {
      if (!el) continue;
      const color = parseCssColor(window.getComputedStyle(el).backgroundColor);
      if (color && color.a > 0.5) return isDarkColor(color);
    }
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

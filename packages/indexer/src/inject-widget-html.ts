// The "other framework" counterpart to inject-widget.ts's AST-based Next.js
// injection. There's no JSX tree to parse for a Vue/Angular/Svelte/plain-HTML
// project — the one thing every one of those has in common is a real HTML
// entry file the browser actually loads, so this finds that file and does a
// plain text insertion instead, wrapped in HTML comment markers so removal
// (cairn remove) is an exact, reversible string operation rather than a
// second parser.
//
// Deliberately narrow about what counts as "found": only ever inserts
// before a real `</body>` tag in a file it can locate by one of a few
// common conventions (Vite/CRA/plain HTML's root index.html, or a public/
// dir variant). Anything it doesn't recognize falls back to printing the
// two-line manual snippet — same "don't guess" discipline as inject-widget.ts.

import fs from "node:fs";
import path from "node:path";

export interface HtmlInjectOptions {
  apiPort: number;
  voice: boolean;
  realtimePort: number | null; // null when voice wasn't set up
  widgetScriptPath: string; // path (relative to the HTML file's own dir, as served) to the copied cairn-widget.js
  persona?: string;
}

export interface HtmlInjectResult {
  injected: boolean;
  filePath?: string;
  reason?: string;
}

const START_MARKER = "<!-- cairn:start -->";
const END_MARKER = "<!-- cairn:end -->";

// Checked in order — the first one that exists wins. Covers Vite, CRA, and
// a plain static site's own root index.html; a project with none of these
// (a server-rendered template with no single static HTML file, e.g. Rails
// ERB or Django templates) isn't something a generic text-insertion pass
// should guess at — it falls through to the manual-instructions path.
const CANDIDATE_HTML_FILES = ["index.html", path.join("public", "index.html")];

function findHtmlEntry(absDir: string): string | null {
  for (const rel of CANDIDATE_HTML_FILES) {
    const p = path.join(absDir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function widgetBlock(opts: HtmlInjectOptions): string {
  const attrs = [`endpoint="http://localhost:${opts.apiPort}/api/copilot"`];
  if (opts.persona) attrs.push(`persona="${opts.persona}"`);
  if (opts.voice) {
    attrs.push(`speak-endpoint="http://localhost:${opts.apiPort}/api/copilot/speak"`);
    attrs.push(`transcribe-endpoint="http://localhost:${opts.apiPort}/api/copilot/transcribe"`);
    if (opts.realtimePort) attrs.push(`realtime-url="ws://localhost:${opts.realtimePort}"`);
  }
  return [START_MARKER, `<script src="${opts.widgetScriptPath}"></script>`, `<cairn-widget ${attrs.join(" ")}></cairn-widget>`, END_MARKER].join("\n");
}

/** Finds the project's real HTML entry point and inserts the
 * `<cairn-widget>` custom element (plus its loader `<script>`) right
 * before `</body>` — the one place this works identically whether the
 * page is authored by Vue, Angular, Svelte, or nothing at all. Never
 * touches a file it can't find, and only ever inserts once (re-running
 * `cairn setup` is a no-op here if the markers are already present). */
export function injectWidgetHtml(dir: string, opts: HtmlInjectOptions): HtmlInjectResult {
  const absDir = path.resolve(dir);
  const htmlPath = findHtmlEntry(absDir);
  if (!htmlPath) {
    return { injected: false, reason: `no index.html found at the project root or public/ — add the widget manually` };
  }

  const original = fs.readFileSync(htmlPath, "utf8");
  if (original.includes(START_MARKER)) {
    return { injected: false, filePath: htmlPath, reason: "already injected (markers present)" };
  }
  if (!/<\/body>/i.test(original)) {
    return { injected: false, filePath: htmlPath, reason: "no </body> tag found — add the widget manually" };
  }

  const block = widgetBlock(opts);
  const updated = original.replace(/<\/body>/i, `${block}\n</body>`);
  fs.writeFileSync(htmlPath, updated);
  return { injected: true, filePath: htmlPath };
}

/** Exact inverse of injectWidgetHtml — strips everything between (and
 * including) the two markers, leaving the rest of the file untouched.
 * Text-based on purpose (matching how it was inserted) rather than an
 * HTML parser, since the inserted block's own boundaries are exactly
 * known. */
export function removeWidgetFromHtml(filePath: string): { removed: boolean; reason?: string } {
  if (!fs.existsSync(filePath)) return { removed: false, reason: "file no longer exists" };
  const original = fs.readFileSync(filePath, "utf8");
  const startIdx = original.indexOf(START_MARKER);
  const endIdx = original.indexOf(END_MARKER);
  if (startIdx === -1 || endIdx === -1) return { removed: false, reason: "markers not found — widget may have been edited or removed already" };

  const before = original.slice(0, startIdx).replace(/\n?$/, "\n");
  const after = original.slice(endIdx + END_MARKER.length).replace(/^\n/, "");
  fs.writeFileSync(filePath, before + after);
  return { removed: true };
}

/** Copies the built widget bundle (node_modules/@cairnvibe/sdk/dist/cairn-widget.js)
 * next to the HTML entry file it was just injected into, so the `<script
 * src="cairn-widget.js">` tag above actually resolves — a static file
 * server (Vite, CRA, or any plain HTTP server) serves whatever sits next
 * to index.html without any extra config. Returns null (and does nothing)
 * if the built bundle isn't present yet — e.g. a fresh `npm install`
 * before the sdk's own postinstall/build step has run; setup.ts reports
 * this rather than silently leaving a 404. */
export function copyWidgetBundle(absDir: string, htmlPath: string): string | null {
  const source = path.join(absDir, "node_modules", "@cairnvibe", "sdk", "dist", "cairn-widget.js");
  if (!fs.existsSync(source)) return null;
  const dest = path.join(path.dirname(htmlPath), "cairn-widget.js");
  fs.copyFileSync(source, dest);
  return dest;
}

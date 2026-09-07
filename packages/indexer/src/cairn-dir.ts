// The one dedicated folder everything `cairn setup`/`cairn init` generates
// lives in — ui-manifest.json, .env.example, and the bookkeeping
// install-manifest.json that makes `cairn remove` possible. Direct ask:
// "if cairn package is installed it should stay all the things in one
// folder... that could be easily upgradeable and can be delete everything
// in one go." Two files genuinely can't move here — app/api/copilot/
// route.ts and the layout.tsx JSX line only work at their Next.js-
// mandated paths — everything else that has no framework requirement on
// where it lives does.
//
// Backward compatible on purpose: an install from before this existed
// (this repo's own examples/demo-app, a real deployment already running)
// has ui-manifest.json sitting at its project root, not here. Reading
// prefers the new location but falls back to the legacy root path if
// that's the only one that exists — an old install never silently loses
// its manifest just because the indexer was upgraded. Writing always
// targets the new location, so every install stays on the old layout
// forever unless it re-runs `cairn build`/`cairn setup`, which is exactly
// the same "opt in by re-running" behavior every other indexer change
// this session already has.

import fs from "node:fs";
import path from "node:path";

export const CAIRN_DIR = ".cairn";

/** Where a NEW manifest write should go — always the new, consolidated location. */
export function manifestWritePath(absDir: string): string {
  return path.join(absDir, CAIRN_DIR, "ui-manifest.json");
}

/** Where to READ the manifest from — prefers .cairn/, falls back to the
 * legacy root location for installs that predate this, falls back to the
 * new path (even though nothing's there yet) so callers have a single
 * consistent "expected" path to report in a not-found message. */
export function manifestReadPath(absDir: string): string {
  const modern = manifestWritePath(absDir);
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(absDir, "ui-manifest.json");
  if (fs.existsSync(legacy)) return legacy;
  return modern;
}

export function envExampleWritePath(absDir: string): string {
  return path.join(absDir, CAIRN_DIR, ".env.example");
}

export function installManifestPath(absDir: string): string {
  return path.join(absDir, CAIRN_DIR, "install-manifest.json");
}

/** The exact runtime fallback logic above, inlined as source text for the
 * generated route templates — those run in the CONSUMER's own project,
 * with no dependency on this package's own modules, so the same
 * modern-then-legacy lookup has to be duplicated as a string rather than
 * imported. Kept in one place so the two copies (this function's own
 * logic and the generated string) are easy to keep in sync by eye. */
export const MANIFEST_LOOKUP_SNIPPET = `function resolveManifestPath(root) {
  const modern = path.join(root, ".cairn", "ui-manifest.json");
  if (fs.existsSync(modern)) return modern;
  const legacy = path.join(root, "ui-manifest.json");
  if (fs.existsSync(legacy)) return legacy;
  return modern;
}`;

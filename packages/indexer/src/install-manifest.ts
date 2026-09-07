// The bookkeeping record that makes `cairn remove` a real, precise
// operation instead of a heuristic guess at what `cairn setup` touched.
// Written once, as the LAST step of `runSetup` (so a partial/failed setup
// never leaves a stale record claiming more was done than actually was),
// read once, at the START of `runRemove`. Deliberately NOT a Zod schema
// like Manifest — this is internal bookkeeping between two functions in
// this same package, not a cross-package/cross-version contract another
// consumer parses.

import fs from "node:fs";
import path from "node:path";
import { installManifestPath, CAIRN_DIR } from "./cairn-dir";

export interface InstallManifest {
  /** ISO timestamp of the setup run that wrote this. */
  installedAt: string;
  /** Every file `cairn setup`/`cairn init` created outright — safe to
   * delete unconditionally, since nothing here existed before this install
   * touched it. Paths are absolute, resolved once at write time, so
   * `cairn remove` never has to re-derive them from a possibly-different
   * cwd. */
  filesCreated: string[];
  /** The layout/_app file the widget was injected into, if injection
   * succeeded — removeWidget() finds and removes exactly the import +
   * JSX it added, the same AST-precise way injectWidget() added them. */
  layoutFile: string | null;
  /** The wrapper component (components/CairnCopilot.tsx) injectWidget()
   * created — deleted outright on remove, same as any other created file,
   * but tracked separately since removeWidget() needs its path to also
   * strip the (now-broken) import that referenced it. */
  wrapperFile: string | null;
  /** The next.config.* file ensureTranspilePackages() touched, and
   * whether it created a brand-new file (delete the whole thing) or
   * edited an existing one (surgically remove just the two entries it
   * added, leaving whatever else was already there). */
  configFile: { path: string; created: boolean } | null;
  /** package.json's own "dev" script value BEFORE `cairn setup` rewrote
   * it to wrap `cairn-realtime --with "<original>"` — restored verbatim
   * on remove. Null when voice was never set up, so dev was never
   * touched. */
  originalDevScript: string | null;
  /** True when `cairn setup` added a brand-new "prebuild" script (the
   * project had none before) — removed outright on remove. A project
   * that already HAD a prebuild script never reaches this case; setup.ts
   * only ever appends to an existing one it didn't itself just create,
   * which this manifest doesn't need to track since it's not something
   * `cairn setup` introduced and shouldn't be something `cairn remove`
   * tears out. */
  prebuildScriptAdded: boolean;
  /** Always the same three — recorded so `cairn remove` can uninstall
   * them even if a LATER, separate `npm install` added something else
   * that happens to also be a dependency, without guessing which deps
   * are "ours" from package.json alone. */
  packagesInstalled: string[];
}

export function writeInstallManifest(absDir: string, manifest: InstallManifest): void {
  const p = installManifestPath(absDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n");
}

export function readInstallManifest(absDir: string): InstallManifest | null {
  const p = installManifestPath(absDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as InstallManifest;
  } catch {
    return null;
  }
}

export { CAIRN_DIR };

// `cairn remove` — the real "delete everything in one go" this was built
// for. Reverses exactly what `cairn setup` recorded doing, precisely,
// instead of heuristically guessing what's "ours" from the project's
// current state. Two things it deliberately never touches: real API
// credentials (.env/.env.local — reported, not deleted) and anything the
// install-manifest itself doesn't list, since that means either this ran
// before that thing existed or a user created it themselves after setup.
//
// Same @clack/prompts visual language as setup.ts, for the same reason —
// the two are a matched pair (install/uninstall), and a polished install
// wizard next to a plain-text uninstaller would read as unfinished.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readInstallManifest } from "./install-manifest";
import { removeWidget } from "./inject-widget";
import { removeTranspilePackages } from "./ensure-transpile";
import { CAIRN_DIR } from "./cairn-dir";
import { clack } from "./clack";

function removeFileIfPresent(absPath: string): boolean {
  if (!fs.existsSync(absPath)) return false;
  fs.rmSync(absPath, { force: true });
  return true;
}

function listConfiguredEnvKeys(absDir: string): string[] {
  const found = new Set<string>();
  for (const filename of [".env", ".env.local"]) {
    const p = path.join(absDir, filename);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (key && value) found.add(key);
    }
  }
  return [...found].sort();
}

export async function runRemove(dir: string): Promise<void> {
  const absDir = path.resolve(dir);
  const p = await clack();
  p.intro("cairn remove");
  p.log.step(`Looking at ${absDir}`);

  const manifest = readInstallManifest(absDir);
  if (!manifest) {
    p.note(
      [
        `No ${CAIRN_DIR}/install-manifest.json here — this doesn't look like a`,
        "`cairn setup`-managed install (or it predates this command). Nothing removed.",
        "",
        "If Cairn was installed by hand, remove it yourself:",
        "  npm uninstall @cairnvibe/core @cairnvibe/sdk @cairnvibe/indexer",
      ].join("\n"),
      "Nothing to do",
    );
    p.outro("Done.");
    return;
  }

  p.log.step(`Reversing the install from ${manifest.installedAt}`);

  // 1. Every file cairn setup/init created outright.
  if (manifest.filesCreated.length > 0) {
    const lines = manifest.filesCreated.map((f) => {
      const removed = removeFileIfPresent(f);
      return removed ? `removed ${path.relative(absDir, f) || f}` : `skipped ${path.relative(absDir, f) || f} (already gone)`;
    });
    p.log.info(lines.join("\n"));
  }

  // 2. The widget's import + JSX, precisely (never the whole layout file —
  // that's the user's own file, not something this ever created).
  if (manifest.layoutFile) {
    const result = removeWidget(manifest.layoutFile);
    if (result.removed) {
      p.log.success(`removed the widget from ${path.relative(absDir, manifest.layoutFile)}`);
    } else {
      p.log.warn(`couldn't auto-remove the widget: ${result.reason}`);
    }
  }
  if (manifest.wrapperFile) removeFileIfPresent(manifest.wrapperFile);

  // 3. transpilePackages — delete the whole config if we created it,
  // otherwise strip just the entries we added.
  if (manifest.configFile) {
    const result = removeTranspilePackages(manifest.configFile.path, manifest.configFile.created);
    if (result.ok) {
      p.log.success(`cleaned up ${path.relative(absDir, manifest.configFile.path)}`);
    } else {
      p.log.warn(`couldn't auto-clean transpilePackages: ${result.reason}`);
    }
  }

  // 4. package.json — restore the dev script, drop a prebuild script we
  // added from scratch (never one that already existed and got a suffix
  // appended — see install-manifest.ts's own doc comment on that field).
  const pkgPath = path.join(absDir, "package.json");
  if (fs.existsSync(pkgPath) && (manifest.originalDevScript !== null || manifest.prebuildScriptAdded)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      pkg.scripts = pkg.scripts ?? {};
      const restored: string[] = [];
      if (manifest.originalDevScript !== null) {
        pkg.scripts.dev = manifest.originalDevScript;
        restored.push('restored the original "dev" script');
      }
      if (manifest.prebuildScriptAdded) {
        delete pkg.scripts.prebuild;
        restored.push('removed the "prebuild" script');
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
      for (const line of restored) p.log.success(line);
    } catch (err) {
      p.log.warn(`couldn't restore package.json scripts (${(err as Error).message}) — check "dev"/"prebuild" yourself`);
    }
  }

  // 5. The npm packages themselves — a real spinner, matching setup's own
  // polish, instead of a silent multi-second pause with no sign anything
  // is happening.
  if (manifest.packagesInstalled.length > 0) {
    const s = p.spinner();
    s.start(`Uninstalling ${manifest.packagesInstalled.join(", ")}`);
    try {
      execSync(`npm uninstall ${manifest.packagesInstalled.join(" ")}`, { cwd: absDir, stdio: "pipe" });
      s.stop(`Uninstalled ${manifest.packagesInstalled.join(", ")}`);
    } catch (err) {
      s.error("npm uninstall failed");
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      const detail = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || "").trim();
      if (detail) p.log.error(detail);
      p.log.message(`Remove these yourself: npm uninstall ${manifest.packagesInstalled.join(" ")}`);
    }
  }

  // 6. The .cairn/ directory itself — last, since it held the record this
  // whole run just read.
  const cairnDir = path.join(absDir, CAIRN_DIR);
  if (fs.existsSync(cairnDir)) {
    fs.rmSync(cairnDir, { recursive: true, force: true });
    p.log.success(`removed ${CAIRN_DIR}/`);
  }

  // 7. Real credentials are never auto-deleted — report what's still
  // sitting in .env/.env.local so the user can clean them up themselves
  // if they want to.
  const remainingKeys = listConfiguredEnvKeys(absDir);
  if (remainingKeys.length > 0) {
    p.note([`Your own .env/.env.local still has:`, "", ...remainingKeys, "", "Remove those yourself if you don't need them anymore."].join("\n"), "Left untouched");
  }

  p.outro("Cairn is uninstalled.");
}

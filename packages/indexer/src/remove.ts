// `cairn remove` — the real "delete everything in one go" this was built
// for. Reverses exactly what `cairn setup` recorded doing, precisely,
// instead of heuristically guessing what's "ours" from the project's
// current state. Two things it deliberately never touches: real API
// credentials (.env/.env.local — reported, not deleted) and anything the
// install-manifest itself doesn't list, since that means either this ran
// before that thing existed or a user created it themselves after setup.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { readInstallManifest } from "./install-manifest";
import { removeWidget } from "./inject-widget";
import { removeTranspilePackages } from "./ensure-transpile";
import { CAIRN_DIR } from "./cairn-dir";
import { bold, dim, green, red, yellow } from "./ui";

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
  console.log(`${bold("cairn remove")} — looking at ${absDir}\n`);

  const manifest = readInstallManifest(absDir);
  if (!manifest) {
    console.log(
      `No ${CAIRN_DIR}/install-manifest.json here — this doesn't look like a ` +
        `\`cairn setup\`-managed install (or it predates this command). Nothing removed.`,
    );
    console.log(dim(`If Cairn was installed by hand, remove @cairnvibe/core, @cairnvibe/sdk, and @cairnvibe/indexer yourself:`));
    console.log(dim(`  npm uninstall @cairnvibe/core @cairnvibe/sdk @cairnvibe/indexer`));
    return;
  }

  console.log(`Reversing the install from ${manifest.installedAt}\n`);

  // 1. Every file cairn setup/init created outright.
  for (const f of manifest.filesCreated) {
    const removed = removeFileIfPresent(f);
    console.log(removed ? `  removed ${path.relative(absDir, f) || f}` : `  skipped ${path.relative(absDir, f) || f} (already gone)`);
  }

  // 2. The widget's import + JSX, precisely (never the whole layout file —
  // that's the user's own file, not something this ever created).
  if (manifest.layoutFile) {
    const result = removeWidget(manifest.layoutFile);
    if (result.removed) {
      console.log(green(`✓ removed the widget from ${path.relative(absDir, manifest.layoutFile)}`));
    } else {
      console.log(yellow(`\ncouldn't auto-remove the widget: ${result.reason}`));
    }
  }
  if (manifest.wrapperFile) removeFileIfPresent(manifest.wrapperFile);

  // 3. transpilePackages — delete the whole config if we created it,
  // otherwise strip just the entries we added.
  if (manifest.configFile) {
    const result = removeTranspilePackages(manifest.configFile.path, manifest.configFile.created);
    if (result.ok) {
      console.log(green(`✓ cleaned up ${path.relative(absDir, manifest.configFile.path)}`));
    } else {
      console.log(yellow(`\ncouldn't auto-clean transpilePackages: ${result.reason}`));
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
      if (manifest.originalDevScript !== null) {
        pkg.scripts.dev = manifest.originalDevScript;
        console.log(green(`✓ restored the original "dev" script`));
      }
      if (manifest.prebuildScriptAdded) {
        delete pkg.scripts.prebuild;
        console.log(green(`✓ removed the "prebuild" script`));
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    } catch (err) {
      console.log(yellow(`\ncouldn't restore package.json scripts (${(err as Error).message}) — check "dev"/"prebuild" yourself`));
    }
  }

  // 5. The npm packages themselves.
  if (manifest.packagesInstalled.length > 0) {
    try {
      execSync(`npm uninstall ${manifest.packagesInstalled.join(" ")}`, { cwd: absDir, stdio: "pipe" });
      console.log(green(`✓ uninstalled ${manifest.packagesInstalled.join(", ")}`));
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      const detail = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || "").trim();
      console.log(red(`\n✗ npm uninstall failed`));
      if (detail) console.log(detail);
      console.log(dim(`Remove these yourself: npm uninstall ${manifest.packagesInstalled.join(" ")}`));
    }
  }

  // 6. The .cairn/ directory itself — last, since it held the record this
  // whole run just read.
  const cairnDir = path.join(absDir, CAIRN_DIR);
  if (fs.existsSync(cairnDir)) {
    fs.rmSync(cairnDir, { recursive: true, force: true });
    console.log(green(`✓ removed ${CAIRN_DIR}/`));
  }

  // 7. Real credentials are never auto-deleted — report what's still
  // sitting in .env/.env.local so the user can clean them up themselves
  // if they want to.
  const remainingKeys = listConfiguredEnvKeys(absDir);
  if (remainingKeys.length > 0) {
    console.log(`\n${bold("Left untouched")} — your own .env/.env.local still has:`);
    for (const key of remainingKeys) console.log(`  ${key}`);
    console.log(dim("Remove those yourself if you don't need them anymore."));
  }

  console.log(`\n${bold("Done.")} Cairn is uninstalled.`);
}

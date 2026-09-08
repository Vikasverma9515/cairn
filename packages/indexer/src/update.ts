// `cairn update` — check whether the @cairnvibe packages this project
// depends on are the latest published versions, and update them in one
// command. Direct ask: "if someone installs the package... there should
// be a command to check all the updates and one single command to update
// everything to the latest." Two real, previously-missing things this
// closes:
//   1. There was no way to ask "am I current?" without manually running
//      `npm view @cairnvibe/sdk version` three times and comparing by eye.
//   2. Updating meant remembering the exact package list and running
//      `npm install` yourself — easy to update one package and miss
//      another, silently leaving the trio at mismatched versions.
//
// Deliberately checks the REAL installed version from node_modules, not
// just the declared range in package.json — the exact discipline this
// session's own workspace-link bug fix established (a declared range can
// look current while npm silently resolves something stale underneath
// it; only the actual installed copy tells the truth).

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { PACKAGES } from "./setup";
import { clack } from "./clack";

interface PackageStatus {
  name: string;
  /** The real version in node_modules/<pkg>/package.json — null if not installed at all. */
  installed: string | null;
  /** The latest version published to npm — null if the registry lookup itself failed (offline, etc). */
  latest: string | null;
  /** Whether this project's package.json even declares a dependency on it — a package present in
   * node_modules only as someone else's transitive dependency isn't "ours" to report on. */
  declared: boolean;
}

/**
 * Walks up from `absDir` the same way Node's own module resolution does —
 * `<dir>/node_modules/<pkg>`, then `<parent>/node_modules/<pkg>`, and so
 * on to the filesystem root. Real, live-found bug this closes: a plain
 * single-package check (`<absDir>/node_modules/<pkg>` only) reported this
 * repo's OWN demo-app as having @cairnvibe/core/sdk "not installed" —
 * npm workspaces hoist shared deps to the monorepo ROOT node_modules, so
 * demo-app has no node_modules/@cairnvibe of its own at all. Any real npm/
 * yarn/pnpm workspace setup (not just this repo's) can hoist the same
 * way, so a consumer's own monorepo would hit the identical false
 * "not installed" without this.
 */
function readInstalledVersion(absDir: string, pkg: string): string | null {
  let dir = absDir;
  for (;;) {
    const pkgJsonPath = path.join(dir, "node_modules", ...pkg.split("/"), "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        return typeof parsed.version === "string" ? parsed.version : null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root without finding it
    dir = parent;
  }
}

function isDeclared(absDir: string, pkg: string): boolean {
  const pkgJsonPath = path.join(absDir, "package.json");
  if (!fs.existsSync(pkgJsonPath)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    return !!(parsed.dependencies?.[pkg] || parsed.devDependencies?.[pkg]);
  } catch {
    return false;
  }
}

function fetchLatestVersion(pkg: string): string | null {
  try {
    // `npm view` rather than a raw registry fetch — it respects whatever
    // registry/auth/proxy config this machine's npm is already set up
    // with (a private mirror, a corporate proxy) instead of this CLI
    // reimplementing that resolution itself and getting it wrong.
    const out = execSync(`npm view ${pkg} version`, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return out || null;
  } catch {
    return null;
  }
}

async function checkCancel<T>(value: T | symbol, p: Awaited<ReturnType<typeof clack>>): Promise<T> {
  if (p.isCancel(value)) {
    p.cancel("Update cancelled.");
    process.exit(0);
  }
  return value as T;
}

function statusLine(st: PackageStatus): string {
  if (!st.latest) return `${st.name}  ${st.installed ?? "not installed"} — couldn't reach npm to check the latest version`;
  if (!st.installed) return `${st.name}  not installed (latest is ${st.latest})`;
  return st.installed === st.latest ? `${st.name}  ${st.installed} — up to date` : `${st.name}  ${st.installed} -> ${st.latest}`;
}

/**
 * `apply`: install real, immediately (no confirmation) — for scripted/CI
 * use, e.g. `cairn update . --apply`. Interactive use (`cairn update`
 * with no flag) checks, reports, and then ASKS before installing, so a
 * plain `cairn update` is genuinely the one command that both checks and
 * (with a yes) updates — never a surprise write with no flag needed.
 */
export async function runUpdate(dir: string, opts: { apply: boolean }): Promise<void> {
  const p = await clack();
  const absDir = path.resolve(dir);

  const relevant = PACKAGES.filter((pkg) => isDeclared(absDir, pkg) || readInstalledVersion(absDir, pkg));
  if (relevant.length === 0) {
    p.log.warn(`cairn update: no @cairnvibe packages found in ${absDir} (checked package.json and node_modules) — nothing to check.`);
    return;
  }

  const s = p.spinner();
  s.start("Checking npm for the latest versions");
  const statuses: PackageStatus[] = relevant.map((pkg) => ({
    name: pkg,
    installed: readInstalledVersion(absDir, pkg),
    latest: fetchLatestVersion(pkg),
    declared: isDeclared(absDir, pkg),
  }));
  s.stop("Checked npm");

  p.note(statuses.map(statusLine).join("\n"), "@cairnvibe versions");

  const needsUpdate = statuses.filter((st) => st.latest && (!st.installed || st.installed !== st.latest));
  if (needsUpdate.length === 0) {
    p.log.success("Everything is up to date.");
    return;
  }

  const targets = needsUpdate.map((st) => `${st.name}@${st.latest}`);

  if (!opts.apply) {
    const proceed = await checkCancel(
      await p.confirm({ message: `Update ${needsUpdate.length === 1 ? "this package" : `these ${needsUpdate.length} packages`} to the latest now?` }),
      p,
    );
    if (!proceed) {
      p.note(`npm install ${targets.join(" ")}`, "Run this yourself whenever you're ready");
      return;
    }
  }

  const s2 = p.spinner();
  s2.start(`Installing ${targets.join(", ")}`);
  try {
    execSync(`npm install ${targets.join(" ")}`, { cwd: absDir, stdio: "pipe" });
  } catch (err) {
    s2.error("npm install failed");
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    const detail = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || "").trim();
    if (detail) p.log.error(detail);
    p.log.message(`Install these yourself: npm install ${targets.join(" ")}`);
    process.exit(1);
  }
  s2.stop("Installed");

  // Re-read the real installed versions rather than trusting the command's
  // exit code alone — same discipline as installDependencies() in setup.ts,
  // and the exact thing this session's own workspace-link bug taught: a
  // command can succeed while what actually got linked/installed differs
  // from what was asked for.
  const after = needsUpdate.map((st) => `${st.name}  now at ${readInstalledVersion(absDir, st.name) ?? "unknown — check node_modules"}`);
  p.log.success(after.join("\n"));
}

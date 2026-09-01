#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema } from "@cairnvibe/core";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { crawlSite } from "./crawl";
import { describeCrawled } from "./crawl-describe";
import { AnthropicDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { diffManifests, formatDiffAsText } from "./diff";
import { generateDocsMarkdown } from "./docs";
import { runInit } from "./init";
import { runSetup } from "./setup";

/**
 * A local `cairn build`/`npx cairn build` run (as opposed to a hosting
 * platform's own build step, which injects its configured env vars
 * directly into process.env) only ever sees the plain shell environment —
 * it does NOT get a bundler's or framework's automatic .env/.env.local
 * loading, since that's scoped to that tool's own process, not whatever
 * invokes this CLI. A real key sitting in .env was invisible here even
 * though `cairn setup` had written it there — the exact same class of gap
 * already fixed for cairn-realtime's own CLI (realtime-cli.ts), for the
 * exact same reason. No new dependency: .env is a plain KEY=VALUE format.
 * .env.local loads first so it wins (matches Next.js's own precedence);
 * nothing here overrides a real, already-set process.env value (a shell
 * export, or a platform's own injected env vars) — file contents only
 * ever fill a gap, never override something actually set.
 */
function loadDotEnv(dir: string): void {
  for (const filename of [".env.local", ".env"]) {
    const filePath = path.join(dir, filename);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function parseArgs(rest: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = rest[i + 1] ?? "";
      i++;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const dir = positional[0] ?? ".";
  loadDotEnv(dir);

  if (command === "scan") {
    const facts = scanL1(dir);
    process.stdout.write(JSON.stringify(facts, null, 2) + "\n");
    return;
  }

  if (command === "build") {
    const provider = flags.provider === "groq" ? "groq" : "anthropic";
    const keyMissing = provider === "anthropic" ? !process.env.ANTHROPIC_API_KEY : !process.env.GROQ_API_KEYS;

    if (keyMissing && "if-configured" in flags) {
      // Used by the prebuild hook `cairn setup` wires in: a deploy with no key
      // set yet (e.g. the very first one, before env vars are configured on the
      // hosting platform) skips this step instead of failing the whole build —
      // the app still builds and runs, just without an updated manifest.
      console.error(`cairn build --if-configured: no key set for ${provider} — skipping, leaving any existing ui-manifest.json as-is.`);
      return;
    }
    if (provider === "anthropic" && keyMissing) {
      console.error("cairn build: ANTHROPIC_API_KEY is not set. Export it, or pass --provider groq, and re-run.");
      process.exit(1);
    }
    if (provider === "groq" && keyMissing) {
      console.error("cairn build --provider groq: GROQ_API_KEYS is not set (comma-separated). Export it and re-run.");
      process.exit(1);
    }

    const client = provider === "groq" ? new GroqDescribeClient() : new AnthropicDescribeClient();

    // Crawl mode: the positional is a URL to a running app, not a source
    // directory — auto-detected (a directory is never a URL), or forced
    // via --mode=crawl. This is the framework-agnostic path (see
    // ROADMAP.md Phase 2): reads the *rendered* DOM instead of parsing
    // Next.js-specific source conventions, so it works on any framework's
    // output, at the cost of less precision than reading real source.
    const isCrawl = flags.mode === "crawl" || /^https?:\/\//.test(dir);
    if (isCrawl) {
      const outDir = flags.out ?? ".";
      if (flags["storage-state"]) {
        console.error(`cairn build --mode=crawl: replaying saved session from ${flags["storage-state"]}`);
      }
      console.error(`cairn build --mode=crawl: launching a headless browser against ${dir} ...`);
      const facts = await crawlSite({ startUrl: dir, storageStatePath: flags["storage-state"] });
      if (facts.pages.length === 0) {
        console.error(`cairn build --mode=crawl: found no reachable pages at ${dir} — is it actually running?`);
        process.exit(1);
      }
      const l3 = await describeCrawled(outDir, facts, client);
      const manifest = assembleManifest(outDir, facts, { dead: [], conflicts: [] }, l3);

      const validated = ManifestSchema.parse(manifest);
      const outPath = path.join(path.resolve(outDir), "ui-manifest.json");
      fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");

      console.error(
        `cairn build --mode=crawl (${provider}): ${validated.pages.length} page(s) crawled — ` +
          `L3 cache: ${l3.cacheHits} hit / ${l3.cacheMisses} miss.`,
      );
      console.error(`wrote ${outPath}`);
      return;
    }

    const facts = scanL1(dir);
    const l2 = computeL2(dir, facts);
    const l3 = await describeAll(dir, facts, client);
    const manifest = assembleManifest(dir, facts, l2, l3);

    const validated = ManifestSchema.parse(manifest);
    const outPath = path.join(path.resolve(dir), "ui-manifest.json");
    fs.writeFileSync(outPath, JSON.stringify(validated, null, 2) + "\n");

    console.error(
      `cairn build (${provider}): ${validated.pages.length} page(s), ${validated.dead.length} dead file(s), ` +
        `${validated.conflicts.length} conflict(s) — L3 cache: ${l3.cacheHits} hit / ${l3.cacheMisses} miss.`,
    );
    console.error(`wrote ${outPath}`);
    return;
  }

  if (command === "setup") {
    await runSetup(dir);
    return;
  }

  if (command === "init") {
    const result = runInit(dir);
    console.error(`cairn init: detected ${result.framework}.`);
    for (const f of result.filesWritten) console.error(`  wrote   ${path.relative(process.cwd(), f) || f}`);
    for (const f of result.filesSkipped) console.error(`  skipped ${path.relative(process.cwd(), f) || f} (already exists)`);
    console.error("");
    console.error("Next steps:");
    for (const step of result.nextSteps) console.error(`  ${step}`);
    return;
  }

  if (command === "diff") {
    const [oldPath, newPath] = positional;
    if (!oldPath || !newPath) {
      console.error("usage: cairn diff <old-manifest.json> <new-manifest.json>");
      process.exit(1);
    }
    const before = ManifestSchema.parse(JSON.parse(fs.readFileSync(oldPath, "utf8")));
    const after = ManifestSchema.parse(JSON.parse(fs.readFileSync(newPath, "utf8")));
    console.log(formatDiffAsText(diffManifests(before, after)));
    return;
  }

  if (command === "docs") {
    const manifestPath = path.join(path.resolve(dir), "ui-manifest.json");
    if (!fs.existsSync(manifestPath)) {
      console.error(`cairn docs: no ${manifestPath} — run \`cairn build ${dir}\` first.`);
      process.exit(1);
    }
    const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    const outPath = path.join(path.resolve(dir), "CAIRN_DOCS.md");
    fs.writeFileSync(outPath, generateDocsMarkdown(manifest) + "\n");
    console.error(`wrote ${outPath}`);
    return;
  }

  console.error("usage:");
  console.error("  cairn setup [dir]   (the one-command path: installs deps, asks for keys — skippable, wires the widget in, builds once, auto-rebuilds on future `npm run build`)");
  console.error("  cairn init <dir>   (scaffolds the API route/server + .env.example, detects your framework — no prompts, no installs)");
  console.error("  cairn scan <dir>");
  console.error("  cairn build <dir> [--provider anthropic|groq]   (Next.js source scan)");
  console.error("  cairn build <url> [--provider anthropic|groq] [--out <dir>] [--storage-state <file>]   (any framework — crawls a running app; --storage-state replays a saved logged-in session for auth-gated apps)");
  console.error("  cairn diff <old-manifest.json> <new-manifest.json>");
  console.error("  cairn docs <dir>   (reads <dir>/ui-manifest.json, writes <dir>/CAIRN_DOCS.md)");
  process.exit(command ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

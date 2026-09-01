// `cairn setup` — the one-command onboarding path: install what's
// needed, ask only for what's actually optional (skippable), scaffold
// the backend, wire the widget into the real layout file, build the
// manifest once now, and leave a `prebuild` hook so it rebuilds itself
// on every future `npm run build` without another manual step.
//
// Deliberately layered on top of `runInit` rather than replacing it —
// `init` stays the safe, deterministic, non-interactive primitive
// (never touches an existing file, never installs anything, never
// prompts); `setup` is the opinionated wizard built from those same
// primitives plus the two things `init` intentionally doesn't do:
// install dependencies and edit an existing layout file.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runInit } from "./init";
import { injectWidget } from "./inject-widget";
import { ask, askOptional, askYesNo, closePrompts } from "./prompt";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { AnthropicDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { ManifestSchema } from "@cairnvibe/core";

const PACKAGES = ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"];

function readPackageJson(absDir: string): Record<string, any> | null {
  const p = path.join(absDir, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function alreadyInstalled(pkg: Record<string, any> | null): boolean {
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return PACKAGES.every((p) => !!deps[p]);
}

export async function runSetup(dir: string): Promise<void> {
  const absDir = path.resolve(dir);
  console.log(`cairn setup: looking at ${absDir}\n`);

  // 1. Scaffold what init already safely can — framework detection, the
  // backend route, .env.example. Never overwrites anything that exists.
  const init = runInit(dir);
  console.log(`Detected: ${init.framework}`);
  for (const f of init.filesWritten) console.log(`  wrote   ${path.relative(absDir, f) || f}`);
  for (const f of init.filesSkipped) console.log(`  skipped ${path.relative(absDir, f) || f} (already exists)`);
  console.log("");

  if (init.framework === "other") {
    // A generic backend needs a real framework decision (Express? Fastify? something
    // else?) this wizard shouldn't guess at — print init's own manual steps instead
    // of half-automating something it can't verify is right.
    console.log("Not a detected Next.js project — falling back to the manual steps:\n");
    for (const step of init.nextSteps) console.log(`  ${step}`);
    return;
  }

  // 2. Install what's needed — the actual "one command" part. Skips
  // cleanly if already present (e.g. re-running setup after a partial run).
  const pkg = readPackageJson(absDir);
  if (!alreadyInstalled(pkg)) {
    console.log(`Installing ${PACKAGES.join(", ")} ...`);
    try {
      execSync(`npm install ${PACKAGES.join(" ")}`, { cwd: absDir, stdio: "inherit" });
    } catch {
      console.error("\nnpm install failed — install these yourself and re-run `cairn setup`:");
      console.error(`  npm install ${PACKAGES.join(" ")}`);
      return;
    }
  } else {
    console.log("Dependencies already installed — skipping.\n");
  }

  // 3. Ask only what's actually needed, everything skippable.
  console.log("\nA couple of quick questions — press enter to skip anything you'll add later.\n");

  let provider: "anthropic" | "groq" | null = null;
  let providerKey: string | null = null;
  const wantsLLM = await askYesNo("Set up an LLM provider now? (needed for the agent to actually answer anything)", true);
  if (wantsLLM) {
    const choice = (await ask("Anthropic or Groq? [anthropic] ")).toLowerCase();
    provider = choice.startsWith("g") ? "groq" : "anthropic";
    providerKey = await askOptional(
      provider === "anthropic" ? "Paste your ANTHROPIC_API_KEY: " : "Paste your GROQ_API_KEYS: ",
    );
  }

  const wantsVoice = await askYesNo("Set up voice (Deepgram — speech in/out) now?", false);
  const deepgramKey = wantsVoice ? await askOptional("Paste your DEEPGRAM_API_KEY: ") : null;

  closePrompts();

  // 4. Write a real .env (not just .env.example) with whatever was actually given.
  const envLines: string[] = [];
  if (provider === "anthropic") envLines.push(`ANTHROPIC_API_KEY=${providerKey ?? ""}`);
  if (provider === "groq") envLines.push(`GROQ_API_KEYS=${providerKey ?? ""}`);
  if (deepgramKey) envLines.push(`DEEPGRAM_API_KEY=${deepgramKey}`);
  envLines.push("CAIRN_REGISTERED_ACTIONS=");
  const envPath = path.join(absDir, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, envLines.join("\n") + "\n");
    console.log(`\nwrote ${path.relative(absDir, envPath)}`);
  } else {
    console.log(`\n${path.relative(absDir, envPath)} already exists — not overwriting; add keys there yourself if you skipped any above.`);
  }

  // 5. Wire the widget into the real layout file — the one thing `init`
  // deliberately doesn't do. Falls back to printing instructions on
  // anything it can't confidently parse.
  const framework = init.framework as "next-app-router" | "next-pages-router";
  const inject = injectWidget(dir, framework);
  if (inject.injected) {
    console.log(`wired <Copilot/> into ${path.relative(absDir, inject.filePath!)}`);
  } else {
    console.log(`\n<Copilot/> not auto-wired (${inject.reason}). Add it yourself:`);
    console.log('  import { Copilot } from "@cairnvibe/sdk";');
    console.log("  <Copilot registeredActions={[]} onDo={(action, target) => { /* run it */ }} />");
  }

  // 6. Build the manifest once now, if we actually have a usable key —
  // no point trying (and failing loudly) with nothing to call.
  const haveUsableKey = (provider === "anthropic" && providerKey) || (provider === "groq" && providerKey);
  if (haveUsableKey) {
    console.log(`\nBuilding the manifest (${provider}) ...`);
    try {
      // Reuse the same env-var-driven construction `cairn build` uses, rather
      // than duplicating each client's options shape here — the .env written
      // above already has this exact value, this just makes it live for the
      // rest of this process too.
      if (provider === "anthropic") process.env.ANTHROPIC_API_KEY = providerKey!;
      if (provider === "groq") process.env.GROQ_API_KEYS = providerKey!;
      const client = provider === "anthropic" ? new AnthropicDescribeClient() : new GroqDescribeClient();
      const facts = scanL1(dir);
      const l2 = computeL2(dir, facts);
      const l3 = await describeAll(dir, facts, client);
      const manifest = ManifestSchema.parse(assembleManifest(dir, facts, l2, l3));
      fs.writeFileSync(path.join(absDir, "ui-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
      console.log(`wrote ui-manifest.json (${manifest.pages.length} page(s))`);
    } catch (err) {
      console.error(`manifest build failed (${(err as Error).message}) — run \`npx cairn build .\` yourself once your key is confirmed working.`);
    }
  } else {
    console.log("\nNo key given yet — skipping the first build. Run `npx cairn build .` once you've added one to .env.");
  }

  // 7. Wire a prebuild hook so this stays current on every future build/deploy —
  // "just build and redeploy" only works if the manifest regenerates itself.
  if (pkg && !pkg.scripts?.prebuild?.includes("cairn build")) {
    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    fresh.scripts = fresh.scripts ?? {};
    const providerFlag = provider === "groq" ? "groq" : "anthropic";
    fresh.scripts.prebuild = fresh.scripts.prebuild
      ? `${fresh.scripts.prebuild} && cairn build . --provider ${providerFlag} --if-configured`
      : `cairn build . --provider ${providerFlag} --if-configured`;
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    console.log('added a "prebuild" script — the manifest regenerates automatically on every `npm run build`.');
    console.log("(--if-configured means a build with no key set yet skips this step instead of failing the whole build —");
    console.log(" set the same key as an environment variable on whatever platform you deploy to.)");
  }

  console.log("\nDone. `npm run dev` and ask it something.");
}

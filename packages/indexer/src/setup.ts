// `cairn setup` — the one-command onboarding path: install what's
// needed, ask only for what's actually optional (skippable, and picked
// from a real numbered menu rather than typed free text), scaffold the
// backend, wire the widget into the real layout file, build the
// manifest once now, and leave a `prebuild` hook so it rebuilds itself
// on every future `npm run build` without another manual step.
//
// Deliberately layered on top of `runInit` rather than replacing it —
// `init` stays the safe, deterministic, non-interactive primitive
// (never touches an existing file, never installs anything, never
// prompts); `setup` is the opinionated wizard built from those same
// primitives plus the things `init` intentionally doesn't do: install
// dependencies, edit an existing layout file, and actually build.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runInit } from "./init";
import { injectWidget } from "./inject-widget";
import { ensureTranspilePackages } from "./ensure-transpile";
import { askOptional, closePrompts, selectFromList } from "./prompt";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { AnthropicDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { ManifestSchema } from "@cairnvibe/core";
import { Spinner, bold, classifyError, dim, green, red, yellow } from "./ui";

const PACKAGES = ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"];

// Lower than cairn build's own default (6) — a first-time setup is exactly
// the scenario most likely to be running on a free-tier key with a tight
// per-minute token budget; found live, not theoretical (a real `cairn
// setup` run against Groq's on-demand tier hit a 429-retry cascade at the
// default concurrency on a small handful of pages).
const SETUP_BUILD_CONCURRENCY = 3;

type Provider = "anthropic" | "groq";

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

/** One build attempt — spinner-driven, quiet on individual retries (they
 * update the same line instead of scrolling the terminal), and honest
 * about failure instead of throwing a raw stack trace at the user. */
async function attemptBuild(dir: string, provider: Provider, key: string): Promise<{ ok: true; pageCount: number } | { ok: false; error: unknown }> {
  if (provider === "anthropic") process.env.ANTHROPIC_API_KEY = key;
  if (provider === "groq") process.env.GROQ_API_KEYS = key;

  const spinner = new Spinner(`Building the manifest (${provider}) ...`);
  spinner.start();
  try {
    const client = provider === "anthropic" ? new AnthropicDescribeClient() : new GroqDescribeClient();
    const facts = scanL1(dir);
    const l2 = computeL2(dir, facts);
    const l3 = await describeAll(dir, facts, client, SETUP_BUILD_CONCURRENCY, (info) => {
      spinner.update(
        `Building the manifest (${provider}) ... rate-limited, retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt}/${info.maxAttempts})`,
      );
    });
    const manifest = ManifestSchema.parse(assembleManifest(dir, facts, l2, l3));
    fs.writeFileSync(path.join(path.resolve(dir), "ui-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    spinner.stop(green(`✓ wrote ui-manifest.json (${manifest.pages.length} page(s))`));
    return { ok: true, pageCount: manifest.pages.length };
  } catch (err) {
    spinner.stop(red("✗ build failed"));
    return { ok: false, error: err };
  }
}

/** Runs after a failed build: explains what actually went wrong in plain
 * English, then offers real next actions instead of just dying. Loops
 * until the user picks something that resolves (a successful retry) or
 * explicitly chooses to skip. */
async function recoverFromBuildFailure(
  dir: string,
  provider: Provider,
  key: string,
  err: unknown,
): Promise<{ provider: Provider; key: string } | null> {
  const classified = classifyError(err);
  console.log("");
  console.log(yellow(`Here's what happened: ${classified.summary}`));

  const options =
    classified.kind === "rate_limit"
      ? [
          { label: "Try again in a bit (same provider)", value: "retry" },
          { label: "Switch to the other provider and try that instead", value: "switch" },
          { label: "Skip for now — I'll run `npx cairn build .` later", value: "skip" },
        ]
      : classified.kind === "auth"
        ? [
            { label: "Paste the key again (I probably mistyped it)", value: "rekey" },
            { label: "Switch to the other provider instead", value: "switch" },
            { label: "Skip for now — I'll run `npx cairn build .` later", value: "skip" },
          ]
        : [
            { label: "Try again", value: "retry" },
            { label: "Switch to the other provider instead", value: "switch" },
            { label: "Skip for now — I'll run `npx cairn build .` later", value: "skip" },
          ];

  for (;;) {
    const choice = await selectFromList("What do you want to do?", options, 0);

    if (choice === "skip") return null;

    let nextProvider = provider;
    let nextKey = key;

    if (choice === "switch") {
      nextProvider = provider === "anthropic" ? "groq" : "anthropic";
      const pasted = await askOptional(nextProvider === "anthropic" ? "Paste your ANTHROPIC_API_KEY: " : "Paste your GROQ_API_KEYS: ");
      if (!pasted) {
        console.log(dim("No key given — back to the menu."));
        continue;
      }
      nextKey = pasted;
    } else if (choice === "rekey") {
      const pasted = await askOptional(provider === "anthropic" ? "Paste your ANTHROPIC_API_KEY: " : "Paste your GROQ_API_KEYS: ");
      if (!pasted) {
        console.log(dim("No key given — back to the menu."));
        continue;
      }
      nextKey = pasted;
    }
    // choice === "retry" falls through with the same provider/key.

    const result = await attemptBuild(dir, nextProvider, nextKey);
    if (result.ok) return { provider: nextProvider, key: nextKey };

    console.log("");
    console.log(yellow(`Still failing: ${classifyError(result.error).summary}`));
    // loop back to the menu rather than recursing — keeps this one flat retry
    // loop instead of a call stack that grows with every attempt
  }
}

export async function runSetup(dir: string): Promise<void> {
  const absDir = path.resolve(dir);
  console.log(`${bold("cairn setup")} — looking at ${absDir}\n`);

  // 1. Scaffold what init already safely can — framework detection, the
  // backend route, .env.example. Never overwrites anything that exists.
  const init = runInit(dir);
  console.log(`Detected: ${bold(init.framework)}`);
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
    const spinner = new Spinner(`Installing ${PACKAGES.join(", ")} ...`);
    spinner.start();
    try {
      execSync(`npm install ${PACKAGES.join(" ")}`, { cwd: absDir, stdio: "pipe" });
      spinner.stop(green(`✓ installed ${PACKAGES.join(", ")}`));
    } catch {
      spinner.stop(red("✗ npm install failed"));
      console.error(`Install these yourself and re-run \`cairn setup\`:\n  npm install ${PACKAGES.join(" ")}`);
      return;
    }
  } else {
    console.log(dim("Dependencies already installed — skipping."));
  }

  // 3. Ask only what's actually needed, everything skippable, picked from a
  // real menu rather than typed free text.
  console.log(`\n${bold("A couple of quick questions")} — press enter to skip anything you'll add later.\n`);

  let provider: Provider | null = null;
  let providerKey: string | null = null;
  const llmChoice = await selectFromList(
    "Set up an LLM provider now? (needed for the agent to actually answer anything)",
    [
      { label: "Anthropic (Claude)", value: "anthropic" },
      { label: "Groq", value: "groq" },
      { label: "Skip — I'll add one to .env later", value: "skip" },
    ],
    0,
  );
  if (llmChoice !== "skip") {
    provider = llmChoice as Provider;
    providerKey = await askOptional(provider === "anthropic" ? "Paste your ANTHROPIC_API_KEY: " : "Paste your GROQ_API_KEYS: ");
  }

  // Honest about what's actually implemented here — Deepgram is the only
  // voice provider this SDK wires up today, so this is "on or off," not a
  // real multi-provider menu dressed up as one.
  const voiceChoice = await selectFromList(
    "Set up voice now?",
    [
      { label: "Deepgram (speech in + out)", value: "deepgram" },
      { label: "Skip — no voice for now", value: "skip" },
    ],
    1,
  );
  const deepgramKey = voiceChoice === "deepgram" ? await askOptional("Paste your DEEPGRAM_API_KEY: ") : null;

  closePrompts();

  // 3b. Scaffold the speak/transcribe backend routes now that we know
  // whether voice was actually chosen — runInit is idempotent (never
  // overwrites), so calling it again here is safe. Real bug this closes:
  // voice used to write only the key, never the routes or the widget props
  // that would ever call them — "on" did nothing beyond saving a string
  // nothing read.
  const wantsVoice = voiceChoice === "deepgram";
  if (wantsVoice) {
    const voiceInit = runInit(dir, { voice: true });
    for (const f of voiceInit.filesWritten) console.log(`  wrote   ${path.relative(absDir, f) || f}`);
  }

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
  const inject = injectWidget(dir, framework, { voice: wantsVoice });
  if (inject.injected) {
    const voiceNote = wantsVoice ? " — wired for voice (speak + transcribe)" : "";
    console.log(green(`✓ wired the widget into ${path.relative(absDir, inject.filePath!)} (via a new components/CairnCopilot.tsx wrapper)${voiceNote}`));
  } else {
    console.log(`\nWidget not auto-wired (${inject.reason}). Add it yourself:`);
    console.log('  import { Copilot } from "@cairnvibe/sdk";');
    console.log("  <Copilot registeredActions={[]} onDo={(action, target) => { /* run it */ }} />");
    console.log("  (in a \"use client\" component — see examples/demo-app/components/CopilotWithActions.tsx for why)");
  }

  // 5b. @cairnvibe/sdk and @cairnvibe/core ship raw TS/TSX as their main
  // entry deliberately — bundlers need transpilePackages to know to
  // transform it. Without this, real projects fail cold at `next dev`
  // with "Unknown module type", not something a demo on a fresh project
  // would ever surface (this repo's own next.config.js already has it).
  const transpile = ensureTranspilePackages(dir);
  if (transpile.ok) {
    console.log(
      green(
        `✓ ${transpile.created ? "created" : "updated"} ${path.relative(absDir, transpile.filePath!)} with transpilePackages`,
      ),
    );
  } else {
    console.log(`\ntranspilePackages not auto-added (${transpile.reason})`);
  }

  // 6. Build the manifest once now, if we actually have a usable key — no
  // point trying (and failing loudly) with nothing to call. On failure,
  // don't just print a stack trace and give up: classify what went wrong
  // and offer real next steps (retry / switch provider / skip).
  if (provider && providerKey) {
    console.log("");
    let result = await attemptBuild(dir, provider, providerKey);
    if (!result.ok) {
      const recovered = await recoverFromBuildFailure(dir, provider, providerKey, result.error);
      if (recovered) {
        provider = recovered.provider;
        providerKey = recovered.key;
      }
      // else: user chose to skip — fall through with the original provider/key
      // still recorded for the prebuild script below; ui-manifest.json is
      // simply not written yet.
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
    console.log('\nadded a "prebuild" script — the manifest regenerates automatically on every `npm run build`.');
    console.log(dim("(--if-configured means a build with no key set yet skips this step instead of failing the whole build —"));
    console.log(dim(" set the same key as an environment variable on whatever platform you deploy to.)"));
  }

  // 8. Wire the realtime voice relay into the normal dev workflow — the
  // other real half of "voice was completely unwired." realtimeUrl on the
  // widget (wired above) just fails to connect if nothing's actually
  // listening on that port; found live, and indistinguishable from "voice
  // doesn't work" with zero indication that a whole separate process needs
  // to be running. `cairn-realtime --with "<original dev command>"` runs
  // both from the one command a project's dev workflow already uses,
  // instead of a second terminal nobody remembers to open. Wraps whatever
  // `dev` already does (a custom server, Turbopack, anything) rather than
  // replacing it — the realtime relay runs alongside it, not instead of it.
  if (wantsVoice && pkg?.scripts?.dev && !pkg.scripts.dev.includes("cairn-realtime")) {
    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    const originalDev = fresh.scripts.dev as string;
    fresh.scripts.dev = `cairn-realtime --port 3010 --with ${JSON.stringify(originalDev)}`;
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    console.log(green('✓ wired the realtime voice relay into `npm run dev` — it now starts alongside your app automatically.'));
    console.log(dim("(a missing/invalid Deepgram key skips voice only, never blocks your app's own dev server from starting.)"));
  }

  console.log(`\n${bold("Done.")} \`npm run dev\` and ask it something.`);
}

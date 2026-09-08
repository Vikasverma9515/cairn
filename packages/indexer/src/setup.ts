// `cairn setup` — the one-command onboarding path: install what's
// needed, ask only for what's actually optional (skippable, and picked
// from a real interactive menu rather than typed free text), scaffold the
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
//
// UI layer: @clack/prompts (see clack.ts's own doc comment for why a
// dynamic-import bridge is needed to use a pure-ESM package from this
// CommonJS-compiled CLI) — real research behind this choice, not a
// guess: it's the current, widely-used default for polished interactive
// CLI installers (create-t3-app, create-next-app, and most modern
// scaffolding tools use it or a close relative). Three concrete,
// previously-real gaps this closes, not just a reskin:
//   1. API keys were typed in PLAIN TEXT (askOptional/readline) — now
//      masked via password().
//   2. `npm install` failing had NO retry path at all — straight to
//      "install these yourself and re-run," even for a transient
//      network blip. Now the same real retry loop the manifest build
//      already had.
//   3. Every long-running step (install, build) now shows a real
//      animated spinner with live status text instead of a static
//      "Installing..." line that gives no sign anything is happening.

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { runInit } from "./init";
import { injectWidget } from "./inject-widget";
import { ensureTranspilePackages } from "./ensure-transpile";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { AnthropicDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { ManifestSchema } from "@cairnvibe/core";
import { classifyError } from "./ui";
import { manifestWritePath } from "./cairn-dir";
import { writeInstallManifest, type InstallManifest } from "./install-manifest";
import { clack } from "./clack";

export const PACKAGES = ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"];

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

/** Every clack prompt returns `Value | symbol` — a real, distinct symbol
 * sentinel when the user cancels (Ctrl+C), checked via `isCancel`. This
 * is the one place that check happens: every prompt call site pipes its
 * result through here, so a cancel always exits the same clean way
 * instead of needing the same three lines repeated at every call site,
 * or (worse) risking a raw symbol leaking into code that expects a
 * string. */
async function checkCancel<T>(value: T | symbol, p: Awaited<ReturnType<typeof clack>>): Promise<T> {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }
  return value as T;
}

/** One build attempt — spinner-driven, with the rate-limit/retry status
 * updating the SAME spinner line (clack's `.message()`) rather than
 * scrolling the terminal, and honest about failure instead of throwing a
 * raw stack trace at the user. */
async function attemptBuild(
  dir: string,
  provider: Provider,
  key: string,
  p: Awaited<ReturnType<typeof clack>>,
): Promise<{ ok: true; pageCount: number } | { ok: false; error: unknown }> {
  if (provider === "anthropic") process.env.ANTHROPIC_API_KEY = key;
  if (provider === "groq") process.env.GROQ_API_KEYS = key;

  const s = p.spinner();
  s.start(`Building the manifest (${provider})`);
  try {
    const client = provider === "anthropic" ? new AnthropicDescribeClient() : new GroqDescribeClient();
    const facts = scanL1(dir);
    const l2 = computeL2(dir, facts);
    const l3 = await describeAll(dir, facts, client, SETUP_BUILD_CONCURRENCY, (info) => {
      s.message(`Building the manifest (${provider}) — rate-limited, retrying in ${Math.round(info.delayMs / 1000)}s (attempt ${info.attempt}/${info.maxAttempts})`);
    });
    const manifest = ManifestSchema.parse(assembleManifest(dir, facts, l2, l3));
    const outPath = manifestWritePath(path.resolve(dir));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
    s.stop(`Wrote ui-manifest.json (${manifest.pages.length} page(s))`);
    return { ok: true, pageCount: manifest.pages.length };
  } catch (err) {
    s.error("Build failed");
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
  p: Awaited<ReturnType<typeof clack>>,
): Promise<{ provider: Provider; key: string } | null> {
  const classified = classifyError(err);
  p.log.warn(`Here's what happened: ${classified.summary}`);

  const options =
    classified.kind === "rate_limit"
      ? [
          { value: "retry", label: "Try again in a bit (same provider)" },
          { value: "switch", label: "Switch to the other provider and try that instead" },
          { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
        ]
      : classified.kind === "auth"
        ? [
            { value: "rekey", label: "Paste the key again (I probably mistyped it)" },
            { value: "switch", label: "Switch to the other provider instead" },
            { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
          ]
        : [
            { value: "retry", label: "Try again" },
            { value: "switch", label: "Switch to the other provider instead" },
            { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
          ];

  for (;;) {
    const choice = await checkCancel(await p.select({ message: "What do you want to do?", options }), p);

    if (choice === "skip") return null;

    let nextProvider = provider;
    let nextKey = key;

    if (choice === "switch" || choice === "rekey") {
      if (choice === "switch") nextProvider = provider === "anthropic" ? "groq" : "anthropic";
      const pasted = await checkCancel(
        await p.password({ message: nextProvider === "anthropic" ? "Paste your ANTHROPIC_API_KEY" : "Paste your GROQ_API_KEYS" }),
        p,
      );
      if (!pasted) {
        p.log.message("No key given — back to the menu.");
        continue;
      }
      nextKey = pasted;
    }
    // choice === "retry" falls through with the same provider/key.

    const result = await attemptBuild(dir, nextProvider, nextKey, p);
    if (result.ok) return { provider: nextProvider, key: nextKey };

    p.log.warn(`Still failing: ${classifyError(result.error).summary}`);
    // loop back to the menu rather than recursing — keeps this one flat retry
    // loop instead of a call stack that grows with every attempt
  }
}

/** `npm install` retry loop — the real gap this whole redesign was
 * prompted by: a transient network blip or registry hiccup used to be a
 * dead end ("install these yourself and re-run"), even though the SAME
 * command usually just works a moment later. Mirrors
 * recoverFromBuildFailure's own shape (classify, offer real choices,
 * loop until resolved or skipped) rather than inventing a different
 * pattern for what's the same real problem. */
async function installDependencies(absDir: string, p: Awaited<ReturnType<typeof clack>>): Promise<boolean> {
  for (;;) {
    const s = p.spinner();
    s.start(`Installing ${PACKAGES.join(", ")}`);
    try {
      execSync(`npm install ${PACKAGES.join(" ")}`, { cwd: absDir, stdio: "pipe" });
      s.stop(`Installed ${PACKAGES.join(", ")}`);
      return true;
    } catch (err) {
      s.error("npm install failed");
      // Real, live-found bug this closes: `catch {}` (no bound error) used to
      // throw away npm's own stderr — the ONE thing that actually explains
      // why it failed (a real registry error, an ERESOLVE conflict, a
      // permissions problem, no network) — leaving a user with nothing but
      // "failed, try again," which just fails the same way for the same
      // unknown reason. execSync's thrown error carries the captured output
      // on `.stderr`/`.stdout` (Buffers, from the `stdio: "pipe"` above)
      // even though the command itself never printed anything to this
      // process's own stderr — surface it instead of discarding it.
      const e = err as { stderr?: Buffer; stdout?: Buffer };
      const detail = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || "").trim();
      if (detail) p.log.error(detail);

      const choice = await checkCancel(
        await p.select({
          message: "What do you want to do?",
          options: [
            { value: "retry", label: "Try again" },
            { value: "skip", label: "Skip — I'll install these myself" },
          ],
        }),
        p,
      );
      if (choice === "skip") {
        p.log.message(`Install these yourself and re-run \`cairn setup\`:\n  npm install ${PACKAGES.join(" ")}`);
        return false;
      }
      // choice === "retry" loops back to the top and tries again.
    }
  }
}

export async function runSetup(dir: string): Promise<void> {
  const absDir = path.resolve(dir);
  const p = await clack();
  p.intro("cairn setup");
  p.log.step(`Looking at ${absDir}`);

  // 1. Scaffold what init already safely can — framework detection, the
  // backend route, .env.example. Never overwrites anything that exists.
  const init = runInit(dir);
  const scaffoldLines = [
    `Detected: ${init.framework}`,
    ...init.filesWritten.map((f) => `wrote   ${path.relative(absDir, f) || f}`),
    ...init.filesSkipped.map((f) => `skipped ${path.relative(absDir, f) || f} (already exists)`),
  ];
  p.log.info(scaffoldLines.join("\n"));

  if (init.framework === "other") {
    // A generic backend needs a real framework decision (Express? Fastify? something
    // else?) this wizard shouldn't guess at — print init's own manual steps instead
    // of half-automating something it can't verify is right.
    p.note(init.nextSteps.join("\n"), "Not a detected Next.js project — manual steps");
    p.outro("Done.");
    return;
  }

  // 2. Install what's needed — the actual "one command" part. Skips
  // cleanly if already present (e.g. re-running setup after a partial run).
  const pkg = readPackageJson(absDir);
  const alreadyHadDeps = alreadyInstalled(pkg);
  if (!alreadyHadDeps) {
    const installed = await installDependencies(absDir, p);
    if (!installed) {
      p.outro("Stopped — re-run `cairn setup` once dependencies are installed.");
      return;
    }
  } else {
    p.log.message("Dependencies already installed — skipping.");
  }

  // 3. Ask only what's actually needed, everything skippable, picked from a
  // real interactive menu. API keys are masked (password()) — never
  // echoed in plain text to a terminal that might be recorded/shared.
  let provider: Provider | null = null;
  let providerKey: string | null = null;
  const llmChoice = await checkCancel(
    await p.select({
      message: "Set up an LLM provider now? (needed for the agent to actually answer anything)",
      options: [
        { value: "anthropic", label: "Anthropic (Claude)" },
        { value: "groq", label: "Groq" },
        { value: "skip", label: "Skip — I'll add one to .env later" },
      ],
      initialValue: "anthropic",
    }),
    p,
  );
  if (llmChoice !== "skip") {
    provider = llmChoice as Provider;
    const pasted = await checkCancel(
      await p.password({ message: provider === "anthropic" ? "Paste your ANTHROPIC_API_KEY (or press enter to skip)" : "Paste your GROQ_API_KEYS (or press enter to skip)" }),
      p,
    );
    providerKey = pasted || null;
  }

  // Honest about what's actually implemented here — Deepgram is the only
  // voice provider this SDK wires up today, so this is "on or off," not a
  // real multi-provider menu dressed up as one.
  const voiceChoice = await checkCancel(
    await p.select({
      message: "Set up voice now?",
      options: [
        { value: "deepgram", label: "Deepgram (speech in + out)" },
        { value: "skip", label: "Skip — no voice for now" },
      ],
      initialValue: "skip",
    }),
    p,
  );
  const deepgramKey =
    voiceChoice === "deepgram" ? (await checkCancel(await p.password({ message: "Paste your DEEPGRAM_API_KEY (or press enter to skip)" }), p)) || null : null;

  // 3b. Scaffold the speak/transcribe backend routes now that we know
  // whether voice was actually chosen — runInit is idempotent (never
  // overwrites), so calling it again here is safe. Real bug this closes:
  // voice used to write only the key, never the routes or the widget props
  // that would ever call them — "on" did nothing beyond saving a string
  // nothing read.
  const wantsVoice = voiceChoice === "deepgram";
  let voiceFilesWritten: string[] = [];
  if (wantsVoice) {
    const voiceInit = runInit(dir, { voice: true });
    voiceFilesWritten = voiceInit.filesWritten;
    if (voiceFilesWritten.length) p.log.info(voiceFilesWritten.map((f) => `wrote   ${path.relative(absDir, f) || f}`).join("\n"));
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
    p.log.success(`wrote ${path.relative(absDir, envPath)}`);
  } else {
    p.log.message(`${path.relative(absDir, envPath)} already exists — not overwriting; add keys there yourself if you skipped any above.`);
  }

  // 5. Wire the widget into the real layout file — the one thing `init`
  // deliberately doesn't do. Falls back to printing instructions on
  // anything it can't confidently parse.
  const framework = init.framework as "next-app-router" | "next-pages-router";
  const inject = injectWidget(dir, framework, { voice: wantsVoice });
  if (inject.injected) {
    const voiceNote = wantsVoice ? " — wired for voice (speak + transcribe)" : "";
    p.log.success(`wired the widget into ${path.relative(absDir, inject.filePath!)} (via a new components/CairnCopilot.tsx wrapper)${voiceNote}`);
  } else {
    p.log.warn(
      [
        `Widget not auto-wired (${inject.reason}). Add it yourself:`,
        `  import { Copilot } from "@cairnvibe/sdk";`,
        `  <Copilot registeredActions={[]} onDo={(action, target) => { /* run it */ }} />`,
        `  (in a "use client" component — see examples/demo-app/components/CopilotWithActions.tsx for why)`,
      ].join("\n"),
    );
  }

  // 5b. @cairnvibe/sdk and @cairnvibe/core ship raw TS/TSX as their main
  // entry deliberately — bundlers need transpilePackages to know to
  // transform it. Without this, real projects fail cold at `next dev`
  // with "Unknown module type", not something a demo on a fresh project
  // would ever surface (this repo's own next.config.js already has it).
  const transpile = ensureTranspilePackages(dir);
  if (transpile.ok) {
    p.log.success(`${transpile.created ? "created" : "updated"} ${path.relative(absDir, transpile.filePath!)} with transpilePackages`);
  } else {
    p.log.message(`transpilePackages not auto-added (${transpile.reason})`);
  }

  // 6. Build the manifest once now, if we actually have a usable key — no
  // point trying (and failing loudly) with nothing to call. On failure,
  // don't just print a stack trace and give up: classify what went wrong
  // and offer real next steps (retry / switch provider / skip).
  if (provider && providerKey) {
    let result = await attemptBuild(dir, provider, providerKey, p);
    if (!result.ok) {
      const recovered = await recoverFromBuildFailure(dir, provider, providerKey, result.error, p);
      if (recovered) {
        provider = recovered.provider;
        providerKey = recovered.key;
      }
      // else: user chose to skip — fall through with the original provider/key
      // still recorded for the prebuild script below; ui-manifest.json is
      // simply not written yet.
    }
  } else {
    p.log.message("No key given yet — skipping the first build. Run `npx cairn build .` once you've added one to .env.");
  }

  // 7. Wire a prebuild hook so this stays current on every future build/deploy —
  // "just build and redeploy" only works if the manifest regenerates itself.
  // prebuildScriptAdded tracks only the case where the project had NO
  // prebuild script at all before this — `cairn remove` deletes exactly
  // that case outright. A project that already had one and got ours
  // appended isn't tracked for removal; untangling an appended suffix
  // from whatever the project's own prebuild script does isn't something
  // worth automating precisely, versus just leaving it for the (rare)
  // case where it's actually the concern.
  let prebuildScriptAdded = false;
  if (pkg && !pkg.scripts?.prebuild?.includes("cairn build")) {
    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    fresh.scripts = fresh.scripts ?? {};
    const providerFlag = provider === "groq" ? "groq" : "anthropic";
    prebuildScriptAdded = !fresh.scripts.prebuild;
    fresh.scripts.prebuild = fresh.scripts.prebuild
      ? `${fresh.scripts.prebuild} && cairn build . --provider ${providerFlag} --if-configured`
      : `cairn build . --provider ${providerFlag} --if-configured`;
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    p.log.success('added a "prebuild" script — the manifest regenerates automatically on every `npm run build`.');
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
  let originalDevScript: string | null = null;
  if (wantsVoice && pkg?.scripts?.dev && !pkg.scripts.dev.includes("cairn-realtime")) {
    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    originalDevScript = fresh.scripts.dev as string;
    fresh.scripts.dev = `cairn-realtime --port 3010 --with ${JSON.stringify(originalDevScript)}`;
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    p.log.success("wired the realtime voice relay into `npm run dev` — it now starts alongside your app automatically.");
  }

  // 9. Record exactly what this run touched — the ONE thing that makes
  // `cairn remove` a real, precise reversal instead of a guess. Written
  // last, on purpose: a run that fails or is skipped partway through
  // (framework not detected, npm install failed) never leaves a stale
  // record claiming more happened than actually did. .env is
  // deliberately never listed — real credentials a user may have since
  // added to it must never be something an uninstall auto-deletes.
  const installManifest: InstallManifest = {
    installedAt: new Date().toISOString(),
    filesCreated: [
      ...init.filesWritten,
      ...voiceFilesWritten,
      ...(inject.injected && inject.wrapperPath && fs.existsSync(inject.wrapperPath) ? [inject.wrapperPath] : []),
      ...(transpile.ok && transpile.created && transpile.filePath ? [transpile.filePath] : []),
    ],
    layoutFile: inject.injected ? (inject.filePath ?? null) : null,
    wrapperFile: inject.injected ? (inject.wrapperPath ?? null) : null,
    configFile: transpile.ok && transpile.filePath ? { path: transpile.filePath, created: !!transpile.created } : null,
    originalDevScript,
    prebuildScriptAdded,
    packagesInstalled: PACKAGES,
  };
  writeInstallManifest(absDir, installManifest);

  p.note(
    ["`npm run dev`, then ask it something.", "", "Everything this generated is tracked in .cairn/ —", "`cairn remove` undoes it in one command."].join("\n"),
    "Next steps",
  );
  p.outro("Done.");
}

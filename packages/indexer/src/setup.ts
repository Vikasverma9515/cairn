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
import { injectWidgetHtml, copyWidgetBundle } from "./inject-widget-html";
import { buildCairnAgentsDoc } from "./agents-doc";
import { buildOrchestratorScript, type OrchestratorCommand } from "./orchestrator";
import { ensureTranspilePackages } from "./ensure-transpile";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";
import { describeAll } from "./l3-describe";
import { crawlSite } from "./crawl";
import { describeCrawled } from "./crawl-describe";
import { AnthropicDescribeClient, GeminiDescribeClient, GroqDescribeClient } from "./llm";
import { assembleManifest } from "./manifest";
import { ManifestSchema } from "@cairnvibe/core";
import { classifyError } from "./ui";
import { manifestWritePath } from "./cairn-dir";
import { writeInstallManifest, type InstallManifest } from "./install-manifest";
import { clack } from "./clack";

export const PACKAGES = ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"];

// Cairn's own npm packages are always installed. A non-Next project also
// needs the standalone backend's own runtime deps (cairn-server.cjs's
// `require("express")`/`require("cors")`) — installed the same way, and
// tracked in the same install manifest, so `cairn remove` uninstalls them
// too instead of leaving orphaned dependencies nothing else uses.
// Real, live-found bug this list used to be missing "dotenv": the
// generated cairn-server.cjs's very first executable line is
// `require("dotenv").config()` (see STANDALONE_SERVER in init.ts) — with
// only express/cors installed, the server crashed on startup with
// MODULE_NOT_FOUND before ever reaching its own route handlers, on every
// single non-Next install, confirmed against a real cloned project.
const STANDALONE_SERVER_DEPS = ["express", "cors", "dotenv"];

const STANDALONE_API_PORT = 4000;
const REALTIME_PORT = 3010;

// Lower than cairn build's own default (6) — a first-time setup is exactly
// the scenario most likely to be running on a free-tier key with a tight
// per-minute token budget; found live, not theoretical (a real `cairn
// setup` run against Groq's on-demand tier hit a 429-retry cascade at the
// default concurrency on a small handful of pages).
const SETUP_BUILD_CONCURRENCY = 3;

export type Provider = "anthropic" | "groq" | "gemini";

const PROVIDER_LABELS: Record<Provider, string> = { anthropic: "Anthropic (Claude)", groq: "Groq", gemini: "Gemini" };
const PROVIDER_KEY_ENV: Record<Provider, string> = { anthropic: "ANTHROPIC_API_KEY", groq: "GROQ_API_KEYS", gemini: "GEMINI_API_KEY" };

/** This CLI's own version — read from its own package.json (works both
 * from ts-node in dev and from the compiled dist/setup.js, since dist
 * sits one level below the package root the same way src does). Used
 * only to stamp the generated docs with what actually produced them;
 * falls back to "unknown" rather than throwing if it's ever unreadable
 * (e.g. an unusual install layout) — never worth failing setup over. */
function readOwnVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    return JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Builds the .env content for whatever the wizard actually collected.
 * Extracted as a pure function specifically so this is unit-testable
 * without mocking the interactive prompt flow — real, live-found bug this
 * guards against a regression of: every generated route/server template
 * (NEXT_APP_ROUTE, NEXT_PAGES_API_ROUTE, STANDALONE_SERVER, and
 * realtime-cli.ts for voice) resolves its runtime provider from
 * `CAIRN_RUNTIME_PROVIDER`, defaulting to "groq" when it's unset. This
 * used to never get written at all — choosing Anthropic or Gemini in the
 * wizard silently did nothing, because the generated backend still only
 * looked for GROQ_API_KEYS. Confirmed live: a real install with Gemini
 * chosen and a real Gemini key configured still failed every single
 * request, because nothing ever told the runtime to actually use it. */
export function buildEnvLines(provider: Provider | null, providerKey: string | null, deepgramKey: string | null): string[] {
  const lines: string[] = [];
  if (provider === "anthropic") lines.push(`ANTHROPIC_API_KEY=${providerKey ?? ""}`);
  if (provider === "groq") lines.push(`GROQ_API_KEYS=${providerKey ?? ""}`);
  if (provider === "gemini") lines.push(`GEMINI_API_KEY=${providerKey ?? ""}`);
  if (provider) lines.push(`CAIRN_RUNTIME_PROVIDER=${provider}`);
  if (deepgramKey) lines.push(`DEEPGRAM_API_KEY=${deepgramKey}`);
  lines.push("CAIRN_REGISTERED_ACTIONS=");
  return lines;
}

function readPackageJson(absDir: string): Record<string, any> | null {
  const p = path.join(absDir, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function alreadyInstalled(pkg: Record<string, any> | null, packages: string[]): boolean {
  if (!pkg) return false;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return packages.every((p) => !!deps[p]);
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
  if (provider === "gemini") process.env.GEMINI_API_KEYS = key;

  const s = p.spinner();
  s.start(`Building the manifest (${provider})`);
  try {
    const client = provider === "anthropic" ? new AnthropicDescribeClient() : provider === "groq" ? new GroqDescribeClient() : new GeminiDescribeClient();
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

/** Crawl-mode counterpart to attemptBuild — reads the *rendered* DOM of a
 * running app instead of parsing Next-specific source conventions, so it
 * works on any frontend framework (or none at all). Same spinner/error
 * shape as attemptBuild so recoverFromBuildFailure's retry menu works
 * identically for both. */
/** Crawl mode needs Playwright's actual Chromium BINARY, a separate
 * multi-hundred-MB download `npm install @cairnvibe/indexer` never
 * triggers on its own — found live, running the crawl step for the first
 * time against a real cloned project: it failed with Playwright's own
 * generic "Executable doesn't exist... run npx playwright install"
 * message, no Cairn context, easy to mistake for a broken install. Rather
 * than leave that for the user to hit and decode, download it here —
 * once, right before the one step that actually needs it (never for a
 * Next.js install, which never crawls at all) — with the same spinner
 * pattern every other long-running step in this wizard already uses.
 * Best-effort: a failure here doesn't abort setup, since the crawl
 * attempt right after this will surface its own clear error (via
 * crawl.ts's launchChromium) if the download didn't actually succeed. */
async function ensurePlaywrightBrowser(absDir: string, p: Awaited<ReturnType<typeof clack>>): Promise<void> {
  const s = p.spinner();
  s.start("Downloading Playwright's Chromium browser (one-time, needed to scan a running app)");
  try {
    execSync("npx playwright install chromium", { cwd: absDir, stdio: "pipe" });
    s.stop("Playwright's Chromium browser is ready");
  } catch (err) {
    const e = err as { stderr?: Buffer; stdout?: Buffer };
    const detail = (e.stderr?.toString().trim() || e.stdout?.toString().trim() || "").trim();
    s.error("Couldn't download Playwright's browser automatically");
    if (detail) p.log.warn(detail);
    p.log.message("Continuing anyway — run `npx playwright install chromium` yourself if the scan below fails.");
  }
}

async function attemptCrawlBuild(
  dir: string,
  url: string,
  provider: Provider,
  key: string,
  p: Awaited<ReturnType<typeof clack>>,
): Promise<{ ok: true; pageCount: number } | { ok: false; error: unknown }> {
  if (provider === "anthropic") process.env.ANTHROPIC_API_KEY = key;
  if (provider === "groq") process.env.GROQ_API_KEYS = key;
  if (provider === "gemini") process.env.GEMINI_API_KEYS = key;

  const s = p.spinner();
  s.start(`Crawling ${url}`);
  try {
    const client = provider === "anthropic" ? new AnthropicDescribeClient() : provider === "groq" ? new GroqDescribeClient() : new GeminiDescribeClient();
    const facts = await crawlSite({ startUrl: url });
    if (facts.pages.length === 0) {
      s.error("No reachable pages found");
      return { ok: false, error: new Error(`found no reachable pages at ${url} — is it actually running?`) };
    }
    s.message(`Describing ${facts.pages.length} page(s) (${provider})`);
    const l3 = await describeCrawled(dir, facts, client);
    const manifest = ManifestSchema.parse(assembleManifest(dir, facts, { dead: [], conflicts: [] }, l3));
    const outPath = manifestWritePath(path.resolve(dir));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
    s.stop(`Wrote ui-manifest.json (${manifest.pages.length} page(s) crawled)`);
    return { ok: true, pageCount: manifest.pages.length };
  } catch (err) {
    s.error("Crawl failed");
    return { ok: false, error: err };
  }
}

/** Runs after a failed build: explains what actually went wrong in plain
 * English, then offers real next actions instead of just dying. Loops
 * until the user picks something that resolves (a successful retry) or
 * explicitly chooses to skip. Takes the actual build attempt as a
 * callback (rather than calling attemptBuild directly) so the same retry
 * menu serves both source-mode (Next) and crawl-mode (any other
 * framework) builds without duplicating this whole flow. */
async function recoverFromBuildFailure(
  runBuild: (provider: Provider, key: string) => Promise<{ ok: true; pageCount: number } | { ok: false; error: unknown }>,
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
          { value: "switch", label: "Switch to a different provider and try that instead" },
          { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
        ]
      : classified.kind === "auth"
        ? [
            { value: "rekey", label: "Paste the key again (I probably mistyped it)" },
            { value: "switch", label: "Switch to a different provider instead" },
            { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
          ]
        : [
            { value: "retry", label: "Try again" },
            { value: "switch", label: "Switch to a different provider instead" },
            { value: "skip", label: "Skip for now — I'll run `npx cairn build .` later" },
          ];

  for (;;) {
    const choice = await checkCancel(await p.select({ message: "What do you want to do?", options }), p);

    if (choice === "skip") return null;

    let nextProvider = provider;
    let nextKey = key;

    if (choice === "switch") {
      const otherProviders = (Object.keys(PROVIDER_LABELS) as Provider[]).filter((v) => v !== provider);
      nextProvider = await checkCancel(
        await p.select({ message: "Switch to which provider?", options: otherProviders.map((v) => ({ value: v, label: PROVIDER_LABELS[v] })) }),
        p,
      );
    }

    if (choice === "switch" || choice === "rekey") {
      const pasted = await checkCancel(await p.password({ message: `Paste your ${PROVIDER_KEY_ENV[nextProvider]}` }), p);
      if (!pasted) {
        p.log.message("No key given — back to the menu.");
        continue;
      }
      nextKey = pasted;
    }
    // choice === "retry" falls through with the same provider/key.

    const result = await runBuild(nextProvider, nextKey);
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
async function installDependencies(absDir: string, p: Awaited<ReturnType<typeof clack>>, packages: string[]): Promise<boolean> {
  for (;;) {
    const s = p.spinner();
    s.start(`Installing ${packages.join(", ")}`);
    try {
      execSync(`npm install ${packages.join(" ")}`, { cwd: absDir, stdio: "pipe" });
      s.stop(`Installed ${packages.join(", ")}`);
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
        p.log.message(`Install these yourself and re-run \`cairn setup\`:\n  npm install ${packages.join(" ")}`);
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

  // A "next-*" project gets the real Next.js scaffolding (API route inside
  // the app, JSX injected into the real layout). Anything else — Vue,
  // Angular, Svelte, plain HTML, a Vite SPA with its own separate backend —
  // gets the framework-agnostic path instead: a standalone backend process
  // (cairn-server.cjs), the <cairn-widget> Web Component injected into the
  // real HTML entry file, and crawl-mode scanning (reads the rendered DOM,
  // not framework-specific source conventions) instead of the Next-only
  // source scanner. Same wizard, same one command, genuinely no framework
  // requirement — not a bailout to a wall of manual steps.
  const isOther = init.framework === "other";

  // 2. Install what's needed — the actual "one command" part. Skips
  // cleanly if already present (e.g. re-running setup after a partial run).
  // A generic backend also needs cairn-server.cjs's own runtime deps.
  const packages = [...PACKAGES, ...(isOther ? STANDALONE_SERVER_DEPS : [])];
  const pkg = readPackageJson(absDir);
  const alreadyHadDeps = alreadyInstalled(pkg, packages);
  if (!alreadyHadDeps) {
    const installed = await installDependencies(absDir, p, packages);
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
        { value: "gemini", label: "Gemini" },
        { value: "skip", label: "Skip — I'll add one to .env later" },
      ],
      initialValue: "anthropic",
    }),
    p,
  );
  if (llmChoice !== "skip") {
    provider = llmChoice as Provider;
    const pasted = await checkCancel(await p.password({ message: `Paste your ${PROVIDER_KEY_ENV[provider]} (or press enter to skip)` }), p);
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
  const envLines = buildEnvLines(provider, providerKey, deepgramKey);
  const envPath = path.join(absDir, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, envLines.join("\n") + "\n");
    p.log.success(`wrote ${path.relative(absDir, envPath)}`);
  } else {
    p.log.message(`${path.relative(absDir, envPath)} already exists — not overwriting; add keys there yourself if you skipped any above.`);
  }

  // 5. Wire the widget in — into the real layout file for Next, or into the
  // real HTML entry file (index.html) for anything else. Falls back to
  // printing instructions on anything it can't confidently parse.
  let nextInject: ReturnType<typeof injectWidget> | null = null;
  let htmlInject: ReturnType<typeof injectWidgetHtml> | null = null;
  let widgetBundlePath: string | null = null;
  if (!isOther) {
    const framework = init.framework as "next-app-router" | "next-pages-router";
    nextInject = injectWidget(dir, framework, { voice: wantsVoice });
    if (nextInject.injected) {
      const voiceNote = wantsVoice ? " — wired for voice (speak + transcribe)" : "";
      p.log.success(`wired the widget into ${path.relative(absDir, nextInject.filePath!)} (via a new components/CairnCopilot.tsx wrapper)${voiceNote}`);
    } else {
      p.log.warn(
        [
          `Widget not auto-wired (${nextInject.reason}). Add it yourself:`,
          `  import { Copilot } from "@cairnvibe/sdk";`,
          `  <Copilot registeredActions={[]} onDo={(action, target) => { /* run it */ }} />`,
          `  (in a "use client" component — see examples/demo-app/components/CopilotWithActions.tsx for why)`,
        ].join("\n"),
      );
    }
  } else {
    htmlInject = injectWidgetHtml(dir, {
      apiPort: STANDALONE_API_PORT,
      voice: wantsVoice,
      realtimePort: wantsVoice ? REALTIME_PORT : null,
      widgetScriptPath: "cairn-widget.js",
    });
    if (htmlInject.injected) {
      widgetBundlePath = copyWidgetBundle(absDir, htmlInject.filePath!);
      const voiceNote = wantsVoice ? " — wired for voice (speak, transcribe, and realtime)" : "";
      if (widgetBundlePath) {
        p.log.success(`wired <cairn-widget> into ${path.relative(absDir, htmlInject.filePath!)}${voiceNote}`);
      } else {
        p.log.warn(
          `wired <cairn-widget> into ${path.relative(absDir, htmlInject.filePath!)}, but couldn't find the built widget bundle to copy next to it — ` +
            `copy node_modules/@cairnvibe/sdk/dist/cairn-widget.js next to that file yourself as cairn-widget.js.`,
        );
      }
    } else {
      p.log.warn(
        [
          `Widget not auto-wired (${htmlInject.reason}). Add it to your HTML yourself, right before </body>:`,
          `  <script src="cairn-widget.js"></script>`,
          `  <cairn-widget endpoint="http://localhost:${STANDALONE_API_PORT}/api/copilot"></cairn-widget>`,
          `  (copy node_modules/@cairnvibe/sdk/dist/cairn-widget.js next to your HTML file as cairn-widget.js)`,
        ].join("\n"),
      );
    }
  }

  // 5b. @cairnvibe/sdk and @cairnvibe/core ship raw TS/TSX as their main
  // entry deliberately — bundlers need transpilePackages to know to
  // transform it. Only meaningful for Next's own bundler config — a
  // non-Next project talks to Cairn only through cairn-server.cjs (plain
  // CommonJS, nothing to transpile) and the prebuilt widget bundle.
  const transpile = isOther ? { ok: false as const, reason: "not a Next.js project" } : ensureTranspilePackages(dir);
  if (!isOther) {
    if (transpile.ok) {
      p.log.success(`${transpile.created ? "created" : "updated"} ${path.relative(absDir, transpile.filePath!)} with transpilePackages`);
    } else {
      p.log.message(`transpilePackages not auto-added (${transpile.reason})`);
    }
  }

  // 6. Build the manifest once now, if we actually have a usable key — no
  // point trying (and failing loudly) with nothing to call. On failure,
  // don't just print a stack trace and give up: classify what went wrong
  // and offer real next steps (retry / switch provider / skip). A non-Next
  // project needs a running URL to crawl (there's no source-tree
  // convention to read the way Next's app/pages dirs give one) — ask for
  // it, and skip cleanly (same honest "run this later" fallback) if the
  // app isn't up yet.
  if (isOther) {
    if (provider && providerKey) {
      const crawlUrl = await checkCancel(
        await p.text({
          message: "Is your app running locally right now? Paste the URL to scan it now (leave empty to skip and run `npx cairn build <url>` later).",
          placeholder: "http://localhost:5173",
          defaultValue: "",
        }),
        p,
      );
      if (crawlUrl) {
        await ensurePlaywrightBrowser(absDir, p);
        const result = await attemptCrawlBuild(dir, crawlUrl, provider, providerKey, p);
        if (!result.ok) {
          const recovered = await recoverFromBuildFailure((prov, key) => attemptCrawlBuild(dir, crawlUrl, prov, key, p), provider, providerKey, result.error, p);
          if (recovered) {
            provider = recovered.provider;
            providerKey = recovered.key;
          }
        }
      } else {
        p.log.message("Skipping the first scan. Once your app is running: npx cairn build <your-app-url>");
      }
    } else {
      p.log.message("No key given yet — skipping the first scan. Run `npx cairn build <your-app-url>` once you've added a key to .env.");
    }
  } else if (provider && providerKey) {
    const result = await attemptBuild(dir, provider, providerKey, p);
    if (!result.ok) {
      const recovered = await recoverFromBuildFailure((prov, key) => attemptBuild(dir, prov, key, p), provider, providerKey, result.error, p);
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
  // Only meaningful for source-mode (a directory to rescan); crawl mode
  // needs a live URL, which a build-time hook doesn't have.
  // prebuildScriptAdded tracks only the case where the project had NO
  // prebuild script at all before this — `cairn remove` deletes exactly
  // that case outright. A project that already had one and got ours
  // appended isn't tracked for removal; untangling an appended suffix
  // from whatever the project's own prebuild script does isn't something
  // worth automating precisely, versus just leaving it for the (rare)
  // case where it's actually the concern.
  let prebuildScriptAdded = false;
  if (!isOther && pkg && !pkg.scripts?.prebuild?.includes("cairn build")) {
    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    fresh.scripts = fresh.scripts ?? {};
    const providerFlag = provider ?? "anthropic";
    prebuildScriptAdded = !fresh.scripts.prebuild;
    fresh.scripts.prebuild = fresh.scripts.prebuild
      ? `${fresh.scripts.prebuild} && cairn build . --provider ${providerFlag} --if-configured`
      : `cairn build . --provider ${providerFlag} --if-configured`;
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    p.log.success('added a "prebuild" script — the manifest regenerates automatically on every `npm run build`.');
  }

  // 8. Wire everything into the ONE command the project already uses to
  // start developing. For Next, that's `cairn-realtime --with "<dev>"` —
  // the realtime relay wraps the existing dev command directly since both
  // run in the same process tree Next already owns. A non-Next project has
  // no such single process to hook into: cairn-server.cjs (the backend)
  // and, if voice is on, cairn-realtime (the voice relay) are genuinely
  // separate processes from the app's own dev server. Rather than leaving
  // that as "open three terminals" (found live to be exactly the kind of
  // step nobody remembers — the same class of bug `--with` itself exists
  // to close), a small generated orchestrator script (cairn-dev.cjs) spawns
  // all of them together under the project's own "dev" script — still one
  // command, same as Next gets.
  let originalDevScript: string | null = null;
  let orchestratorFile: string | null = null;
  if (!isOther) {
    if (wantsVoice && pkg?.scripts?.dev && !pkg.scripts.dev.includes("cairn-realtime")) {
      const pkgPath = path.join(absDir, "package.json");
      const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      originalDevScript = fresh.scripts.dev as string;
      fresh.scripts.dev = `cairn-realtime --port ${REALTIME_PORT} --with ${JSON.stringify(originalDevScript)}`;
      fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
      p.log.success("wired the realtime voice relay into `npm run dev` — it now starts alongside your app automatically.");
    }
  } else if (pkg?.scripts?.dev && !pkg.scripts.dev.includes("cairn-dev.cjs")) {
    const commands: OrchestratorCommand[] = [
      { label: "app", command: pkg.scripts.dev },
      { label: "cairn-backend", command: "node cairn-server.cjs" },
    ];
    if (wantsVoice) commands.push({ label: "cairn-voice", command: `npx cairn-realtime --port ${REALTIME_PORT}` });

    const orchestratorPath = path.join(absDir, "cairn-dev.cjs");
    fs.writeFileSync(orchestratorPath, buildOrchestratorScript(commands));
    orchestratorFile = orchestratorPath;

    const pkgPath = path.join(absDir, "package.json");
    const fresh = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    originalDevScript = fresh.scripts.dev as string;
    fresh.scripts.dev = "node cairn-dev.cjs";
    fs.writeFileSync(pkgPath, JSON.stringify(fresh, null, 2) + "\n");
    p.log.success(
      `wired the Cairn backend${wantsVoice ? " and the realtime voice relay" : ""} into \`npm run dev\` (via cairn-dev.cjs) — one command starts everything.`,
    );
  } else if (isOther && !pkg?.scripts?.dev) {
    p.log.message(
      [
        `No "dev" script found to wire into — start these alongside your app yourself:`,
        `  node cairn-server.cjs`,
        ...(wantsVoice ? [`  npx cairn-realtime --port ${REALTIME_PORT}`] : []),
      ].join("\n"),
    );
  }

  // 8b. Write a reference doc INTO the project explaining what Cairn is
  // and how THIS install is wired — for whoever (human or AI coding
  // agent) opens this project later with no memory of this setup run and
  // a real bug to fix or feature to add. Regenerated every run (not
  // writeIfAbsent) since it reflects current config, not a one-time
  // snapshot — a stale copy describing an old setup would actively
  // mislead. A root AGENTS.md is ALSO written, but only if the project
  // doesn't already have one of its own — never overwrite a user's real
  // project instructions; if one already exists, the note below points
  // at .cairn/CAIRN.md manually instead.
  const cairnDocPath = path.join(absDir, ".cairn", "CAIRN.md");
  fs.mkdirSync(path.dirname(cairnDocPath), { recursive: true });
  fs.writeFileSync(
    cairnDocPath,
    buildCairnAgentsDoc({
      framework: init.framework,
      voice: wantsVoice,
      provider,
      packageVersion: readOwnVersion(),
      standaloneApiPort: isOther ? STANDALONE_API_PORT : undefined,
      realtimePort: wantsVoice ? REALTIME_PORT : undefined,
    }),
  );
  const rootAgentsPath = path.join(absDir, "AGENTS.md");
  let wroteRootAgentsStub = false;
  if (!fs.existsSync(rootAgentsPath)) {
    fs.writeFileSync(rootAgentsPath, "# Agent instructions\n\nThis project uses Cairn — see [.cairn/CAIRN.md](./.cairn/CAIRN.md) for what it is, how it's wired in here, and how to debug or extend it.\n");
    wroteRootAgentsStub = true;
  }
  p.log.success(`wrote .cairn/CAIRN.md${wroteRootAgentsStub ? " and a root AGENTS.md pointing at it" : " (add a link to it from your own AGENTS.md/CLAUDE.md)"}`);

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
      ...(nextInject?.injected && nextInject.wrapperPath && fs.existsSync(nextInject.wrapperPath) ? [nextInject.wrapperPath] : []),
      ...(transpile.ok && transpile.created && transpile.filePath ? [transpile.filePath] : []),
      ...(widgetBundlePath ? [widgetBundlePath] : []),
      ...(orchestratorFile ? [orchestratorFile] : []),
      cairnDocPath,
      ...(wroteRootAgentsStub ? [rootAgentsPath] : []),
    ],
    layoutFile: nextInject?.injected ? (nextInject.filePath ?? null) : null,
    wrapperFile: nextInject?.injected ? (nextInject.wrapperPath ?? null) : null,
    htmlWidgetFile: htmlInject?.injected ? (htmlInject.filePath ?? null) : null,
    configFile: transpile.ok && transpile.filePath ? { path: transpile.filePath, created: !!transpile.created } : null,
    originalDevScript,
    prebuildScriptAdded,
    packagesInstalled: packages,
  };
  writeInstallManifest(absDir, installManifest);

  p.note(
    ["`npm run dev`, then ask it something.", "", "Everything this generated is tracked in .cairn/ —", "`cairn remove` undoes it in one command."].join("\n"),
    "Next steps",
  );
  p.outro("Done.");
}

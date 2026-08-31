# Roadmap: any project, any framework

Cairn's goal is to be installable in *any* web project and become that
app's in-app voice consultant — not just Next.js. Two things are worth
separating, because they're at very different stages:

- **The agent** — LLM verb resolution, live voice (streaming TTS, barge-in,
  tours, conversation memory), finding and clicking real DOM elements — is
  already framework-agnostic in its logic. `createCopilotHandler` and
  `createRealtimeServer` (`packages/sdk/src/server.ts`,
  `realtime-server.ts`) are plain Node `http`/`ws`, nothing Next.js-specific.
  `findElement`/`highlightElement` (`packages/sdk/src/element-ladder.ts`)
  are plain `document.querySelector`. This part doesn't need a rewrite.
- **The packaging** — the widget is a React component, and the analyzer
  (`cairn build`) only reads Next.js App/Pages Router conventions. These
  are the actual blockers, and this roadmap is about removing them.

## Phase 0 — real, installable package ✅

Real npm packaging: each package builds to `dist/`, `npm publish --dry-run`
clean, versions bumped to `0.1.0` and linked with proper semver ranges
instead of exact pins. Framework scope stays Next.js-only here — this
phase is packaging hygiene, not new capability. (Not yet actually published
to the npm registry — that's a deliberate separate step.)

## Phase 1 — framework-agnostic widget (MVP shipped, voice parity pending)

`<cairn-widget>` (`packages/sdk/src/web-component.ts`) is a real, working
Web Component — Shadow DOM for style isolation, self-registers on load,
usable via one `<script>` tag on *any* page. **Live-verified**: a genuinely
static HTML file with zero React, zero build step
(`examples/demo-app/public/cairn-widget-test.html`, served as a plain
static asset — no JSX, nothing compiled it) round-tripped a real question
through `/api/copilot` to a real LLM and got a correct spoken+displayed
answer back, exactly the way `<Copilot/>` does in the Next.js apps.

Covers: typed questions, explain/highlight/navigate/do/tour execution,
spoken answers (`speak-endpoint`), push-to-talk mic (`transcribe-endpoint`),
persona. The backend (`createCopilotHandler`/`createRealtimeServer`)
already needed no framework — nothing to build there, just needs an
Express/Fastify doc example alongside the existing Next.js one.

**Deliberately deferred, not yet done:** live realtime voice conversation
(`realtimeUrl`, streaming TTS, barge-in) only exists in the React widget
today. Re-implementing and re-verifying mic PCM streaming + gapless audio
scheduling + barge-in a second time, in one pass, without being able to
re-run the full live-mic verification, was a real risk not worth taking
blind — `<Copilot/>` (React) stays the fully-featured implementation until
that's built and verified on its own. The two are **separate
implementations** right now, not one core with two thin wrappers as
originally sketched — unifying them is follow-up work once the vanilla
path has realtime voice too, not before.

## Phase 2 — runtime-crawl analyzer ✅

`cairn build <url>` (`packages/indexer/src/crawl.ts` + `crawl-describe.ts`)
launches a headless Chromium (Playwright), crawls same-origin links from a
given URL (BFS, depth/page-capped), and for each page pulls interactive
elements straight from the live DOM — same detection rules
`findElement`/`element-ladder.ts` already use at runtime (`data-ai`,
`aria-label`, visible text), and deliberately **not slugified** the way the
Next.js source-reader's fallback ids are, so a crawled element without
`data-ai` still actually resolves at runtime (the source-reader has a
latent gap here — worth fixing there too, not done as part of this phase).
Feeds each page's visible text + element list to the same LLM description
step (`DescribeClient`) that already produces `ui-manifest.json` — same
output shape, so `@cairn/core`'s schema and the runtime widget needed zero
changes, exactly as planned.

**Live-verified, the full pipeline, not just typechecked:** built and
served a genuinely framework-free two-page static HTML site (no build
tool touched it at all), ran `cairn build http://localhost:8123/index.html
--provider groq`, got a real manifest with correct element ids and
reasonable descriptions inferred purely from visible text, then fed that
manifest into `createCopilotHandler` and asked "how do I get support?" —
got back a correct `highlight` verb pointing at the right button. Auto-
detected via the `http(s)://` prefix — no flag needed for the common case.

Known limitations, honest and unresolved: no handling yet for auth-gated
apps (crawls whatever's reachable unauthenticated), no SPA client-side-only
routing detection (relies on real `<a href>` links, won't discover routes
reachable only via `router.push()`-style navigation), no crawl-time
caching keyed on a hash of the deployed build the way the source-reader's
git-commit-scoped cache is — a repeat crawl re-visits every page. No
automated test suite for this yet either (no headless-browser fixture in
CI) — covered only by the live run above, not a repeatable `npm test`
case.

## Phase 3 — `cairn init` ✅

`packages/indexer/src/init.ts`. Detects the framework from `package.json`
(`next` present → App Router or Pages Router scaffold; anything else →
standalone Express server, since `createCopilotHandler` is plain Node and
Express is just the simplest thing to scaffold, not a requirement). Only
ever writes files that don't already exist — never touches something you
already have. Prints the remaining manual steps (env vars, where to mount
the widget) rather than guessing at files it shouldn't edit blind (a
layout file, an app entry point).

**Live-verified, both paths, not just typechecked:** ran `cairn init`
against a fake Next.js App Router project and a fake plain project,
confirmed the right files got scaffolded for each. For the non-Next path,
actually `npm install`ed the generated `cairn-server.cjs`'s real
dependencies (Express, `@cairn/sdk`/`@cairn/core` via `file:`), ran it for
real, and `curl`ed `/api/copilot` — got back a correct (degraded-to-
explain, since the manifest was empty) response from a real Groq call
through the actual generated file, not a hand-written stand-in.

## Phase 4 — open-source polish (partial)

Done: CI (`.github/workflows/ci.yml` — typecheck, test, determinism check,
builds `@cairn/indexer`) and `CONTRIBUTING.md`.

Still open: issue templates, a real docs site, and — the actual point of
open-sourcing this — community-contributed scaffolders/crawlers for
frameworks beyond whatever's built in. Also still open, called out
honestly rather than left implicit: **no automated test coverage for
crawl mode** (Phase 2) or `cairn init` (Phase 3) — both are covered only
by the live manual runs described above, not a repeatable `npm test`
case; a headless-browser fixture for CI is the concrete next step for
either.

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

## Phase 2 — runtime-crawl analyzer (not started)

`cairn build` works on any framework's *rendered output*, without a
separate source-code parser per framework: launch the target app with a
headless browser, crawl reachable pages the way a real user would (follow
links, find clickable elements via the same rules `findElement` already
uses), and feed each page's live DOM to the same LLM description step that
already produces `ui-manifest.json` — same output shape, so nothing
downstream changes. By the time a page reaches the browser, Vue/Angular/
Svelte/Next.js output is just DOM; one crawler covers all of them, at the
cost of needing a running server to crawl and slightly less precision than
reading real source. Keeps the existing Next.js source-reader as an
optional higher-precision mode for Next.js specifically.

Open questions to resolve when this phase starts: auth-gated apps, SPA
client-side routing detection, crawl depth/rate limits, and the added
`playwright` dependency's install footprint.

## Phase 3 — `npx cairn init` (not started)

Detect the framework from `package.json`, scaffold the API route + env
template + widget mount automatically for frameworks with a scaffolder,
fall back to crawl-mode + a copy-paste snippet for anything without one
yet.

## Phase 4 — open-source polish (not started)

CI, `CONTRIBUTING.md`, issue templates, a real docs site, and — the actual
point of open-sourcing this — community-contributed scaffolders for
frameworks beyond whatever's built in.

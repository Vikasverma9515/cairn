# Roadmap: any project, any framework

Cairn's goal is to be installable in *any* web project and become that
app's in-app voice consultant — not just Next.js. Status: **Phases 0-3 are
done** — install (`cairn init`), analyze (`cairn build`, source-read or
crawl), and run (`<cairn-widget>` or `<Copilot/>`, full voice parity
either way) all work outside Next.js now, each live-verified, not just
planned, and both the crawler and `cairn init` now have real automated
test coverage (not just the live manual runs that originally proved them).
What's left (Phase 4) is open-source project health — CI, issue templates,
`CONTRIBUTING.md`, and a real landing page all exist now, but a dedicated
docs site and community-contributed scaffolders for frameworks beyond
what's built in are still open — plus the smaller honest gaps called out
inline below (crawl mode's auth/SPA limits).

## Phase 0 — real, installable package ✅

Real npm packaging: each package builds to `dist/`, versions bumped to
`0.1.0` and linked with proper semver ranges instead of exact pins.
Framework scope stays Next.js-only here — this phase is packaging
hygiene, not new capability. **Published for real** as `@cairnvibe/core`,
`@cairnvibe/indexer`, `@cairnvibe/sdk` (the original `@cairn` scope was
already claimed on npm by the time of publishing — `@cairnvibe` was
picked instead, which happens to fit the "vibe using" positioning on the
landing page).

## Phase 1 — framework-agnostic widget ✅

`<cairn-widget>` (`packages/sdk/src/web-component.ts`) is a real, working
Web Component — Shadow DOM for style isolation, self-registers on load,
usable via one `<script>` tag on *any* page. **Live-verified**: a genuinely
static HTML file with zero React, zero build step
(`examples/demo-app/public/cairn-widget-test.html`, served as a plain
static asset — no JSX, nothing compiled it) round-tripped a real question
through `/api/copilot` to a real LLM and got a correct spoken+displayed
answer back, exactly the way `<Copilot/>` does in the Next.js apps.

Full feature parity with `<Copilot/>`, including live realtime voice
conversation — streaming TTS, gapless PCM audio scheduling, barge-in, mic
mute/speaker mute, tours narrating over an open call, conversation memory.
The backend (`createCopilotHandler`/`createRealtimeServer`) needed zero
changes for any of this, confirming the original "framework-agnostic under
the hood" premise. **Live-verified against the real relay**, not just
typechecked: this sandbox has no real microphone, so `getUserMedia` was
shimmed with a synthetic audio stream to let the rest of the pipeline run
for real — confirmed a genuine WebSocket reaches the live relay, real
synthetic server messages (`speaking_start`, a real base64 PCM16
`audio_chunk`, `turn_complete`) dispatched onto that live socket correctly
schedule real Web Audio API playback (no throw, correct buffer math), the
widget correctly holds `rt-speaking` until *both* the audio finishes
playing *and* the server's completion signal arrives (not just one or the
other), and `endRealtime()` tears down cleanly. Barge-in's internal
threshold logic is a byte-for-byte port of the already-verified React
version; only the live-mic RMS trigger itself wasn't re-exercised (same
no-real-mic boundary as everywhere else this session).

`<Copilot/>` (React) and `<cairn-widget>` (vanilla) are still two separate
implementations sharing the same framework-neutral core — not yet unified
into one core with two thin wrappers as originally sketched. Both are now
fully-featured, so unifying them is a pure refactor whenever it's worth
doing, not blocked on missing functionality anymore.

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
output shape, so `@cairnvibe/core`'s schema and the runtime widget needed zero
changes, exactly as planned.

**Live-verified, the full pipeline, not just typechecked:** built and
served a genuinely framework-free two-page static HTML site (no build
tool touched it at all), ran `cairn build http://localhost:8123/index.html
--provider groq`, got a real manifest with correct element ids and
reasonable descriptions inferred purely from visible text, then fed that
manifest into `createCopilotHandler` and asked "how do I get support?" —
got back a correct `highlight` verb pointing at the right button. Auto-
detected via the `http(s)://` prefix — no flag needed for the common case.

**Auth-gated apps: handled.** `cairn build <url> --storage-state <file>`
replays a Playwright storage-state JSON (cookies + localStorage) captured
from a real logged-in session — deliberately *not* a built-in login flow
(username/password/2FA automation is a much bigger trust boundary than a
generic crawler should own, and breaks on the first real 2FA prompt
anyway); bring your own already-authenticated session instead, the same
way Playwright's own tooling (`npx playwright open --save-storage`)
produces one. Live-verified: a page that only shows its real content when
a specific session cookie is present shows "please log in" without
`--storage-state` and the real (authenticated) content with it.

**SPA client-side-only routing: a known limitation, left alone on
purpose, not just unaddressed.** Crawl mode only follows real `<a href>`
links — it won't discover a route reachable only via a client-side
`router.push()`-style navigation with no real link. The fix would be
clicking every interactive element during the crawl and watching for a
URL change, but that means the *analyzer* — which has no business taking
real actions, ever, matching the exact invariant `resolveVerb` enforces at
runtime for the agent itself — would be clicking real buttons on someone's
real app: "Delete", "Archive", "Confirm Purchase", whatever's on the page,
with no `registeredActions` allowlist to stop it. That's a correctness
trade a generic tool shouldn't make silently. Left as a real, open gap.

No crawl-time caching keyed on a hash of the deployed build the way the
source-reader's git-commit-scoped cache is — a repeat crawl re-visits
every page (the LLM description step's own cache still applies per-page
within that, so it's not re-*describing* unchanged pages, just
re-*visiting* them).

**Automated test coverage** (`packages/indexer/src/crawl.test.ts`, 8
tests, ~8s, no LLM key needed — element extraction only, no describe
step) — a real local HTTP server (two plain HTML pages) and a real
headless Chromium: same-origin crawling, external links extracted as
elements but never followed for further crawling, `maxPages`/`maxDepth`
caps, a 404 start URL degrading to zero pages instead of throwing, the
raw-not-slugified id behavior, and the storage-state auth replay above.
CI installs Chromium via `playwright install --with-deps` to run this.
`cairn init` has its own coverage too
(`packages/indexer/src/init.test.ts`, 10 tests, pure filesystem — no
browser needed): framework detection, the write-only-if-absent guarantee,
and that the generated scaffolds are actually syntactically valid.

## Scaling to large codebases

Not one of the four numbered phases — a real question asked directly
("thousands of files, nothing breaks"), answered by actually measuring it
rather than assuming, and fixing what the measurement found.

**L1 static scan is not the bottleneck.** Generated a synthetic Next.js
app and ran the real `cairn scan` against it: 640 files (40 pages × 15
components each) in **1.2s**; 4,750 files (250 pages × 18 components) in
**3.1s**, peak 808MB memory. Sub-linear scaling, no crash, no blowup —
`ts-morph` handles thousands of files fine, and L1 only ever globs `app/`,
`components/`, `lib/`, `pages/` (never `node_modules`, never the rest of a
large monorepo), so "lakhs of code" in a big repo mostly doesn't get
touched at all unless it's actually in the UI source tree.

**L3 (the LLM description step) was the real bottleneck, and it broke
live.** It described one page at a time, sequentially — for an app with
hundreds of pages, at 1-3s/call that's minutes on a cold build, and
`GroqDescribeClient`'s `KeyRotator` already round-robins multiple API keys
specifically for throughput that a sequential loop never exercised. Fixed
in `packages/indexer/src/concurrency.ts`:

- `mapWithConcurrency` — a bounded worker pool (default 6 for describing,
  4 for crawling), used by both `l3-describe.ts` and `crawl-describe.ts`
  for the describe step, and by `crawl.ts` for visiting same-depth pages
  concurrently instead of one browser tab at a time.
- `withRetry` — **added after live-testing surfaced a real failure, not
  written speculatively**: raising concurrency on a 40-page synthetic app
  hit a genuine Groq 429 ("Rate limit reached... tokens per minute")
  within seconds, which — before this — threw straight out of
  `Promise.all` and **aborted the entire build**, discarding every other
  page's already-completed work. Now retries 429/5xx with backoff
  (honoring a `Retry-After` header when the provider sends one), and if a
  single page still fails after retries, that page alone degrades to an
  honest `confidence: 0` placeholder instead of taking the whole build
  down with it.
- **The degraded placeholder is deliberately never cached** — found by
  inspecting the actual output of the live 40-page run below, not
  theorized: 1 of 40 pages exhausted retries under the test account's
  rate limit and degraded. The first version of this fix cached that
  placeholder like any real description, which would have pinned that
  page to "Unknown, could not describe" on every future build forever
  (same source → same hash → permanent cache hit), even seconds after
  the rate limit cleared. Fixed so a degraded page is simply never
  written to `.cairn-cache/` — the next build's cache-miss pass retries
  it fresh, same as a page that's never been described at all.

**Full live proof, the exact failure end to end:** ran the real
40-page synthetic app against the real Groq API with the fix in place.
Hit the actual rate limit **seven separate times** over the run (visible
in the raw output — real 429s, real `Retry-After` values, waits up to
45s), and the build still completed successfully: `40 page(s), 0 dead
file(s), 0 conflict(s)` — no crash, every other page's work preserved
while the limited ones waited their turn. Total wall time: 8m40s, almost
entirely rate-limit backoff, not compute — this specific test account's
free-tier limit (8,000 tokens/minute) is unusually tight; a production
account would clear this same 40-page app in a fraction of the time.
1 of the 40 pages did exhaust its retries and degrade — confirmed *not*
cached, confirmed a second `describeAll()` call against the same pages
retried and correctly described it (see the "never cached" test).

Concurrency defaults are deliberately modest (not maximal) — the ceiling
is always whatever the provider account's real rate limit is; this just
stops leaving most of a rotated key pool idle, and the retry logic is what
actually makes a large cold build resilient rather than the concurrency
number itself.

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
dependencies (Express, `@cairnvibe/sdk`/`@cairnvibe/core` via `file:`), ran it for
real, and `curl`ed `/api/copilot` — got back a correct (degraded-to-
explain, since the manifest was empty) response from a real Groq call
through the actual generated file, not a hand-written stand-in. Now backed
by `packages/indexer/src/init.test.ts` too (10 tests, pure filesystem) —
framework detection for both Next.js router styles and the fallback,
never overwriting an existing file, and that the generated scaffolds are
syntactically valid.

## Phase 4 — open-source polish (partial)

Done: CI (`.github/workflows/ci.yml` — typecheck, test, determinism check,
builds `@cairnvibe/indexer`, installs Chromium for `crawl.test.ts`),
`CONTRIBUTING.md`, GitHub issue templates (`.github/ISSUE_TEMPLATE/`), a
real landing page (`site/index.html`, deployed at
[cairn-phi-flame.vercel.app](https://cairn-phi-flame.vercel.app)), and
**`npm publish`** itself — `@cairnvibe/core`, `@cairnvibe/indexer`, and
`@cairnvibe/sdk` are live on the registry, verified with a real install
into a fresh empty directory (not just a dry-run).

Still open, and not something a single session can finish alone:
- **A dedicated docs site** beyond the README/landing page — nice-to-have,
  not blocking; the README already covers install, API, and CLI in full.
- **Community-contributed scaffolders/crawlers for frameworks beyond
  Next.js** — the actual point of open-sourcing this. By definition this
  needs outside contributors showing up, not more solo engineering.

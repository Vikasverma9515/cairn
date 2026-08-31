# Contributing

## Setup

```bash
npm install
npm run build --workspaces --if-present   # @cairn/core, @cairn/sdk, @cairn/indexer — in that order, needed before anything else typechecks
```

Run the explicit build, don't rely on `npm install` alone — `@cairn/core`
has a `prepare` script (safe: it has no workspace-sibling dependencies of
its own), but `@cairn/sdk` deliberately doesn't, even though it depends on
`@cairn/core`. Found live, a real CI failure not just a local repro: npm's
workspace `prepare` fan-out during a plain `npm ci`/`npm install` doesn't
reliably order *sibling* workspaces by their actual dependency graph — with
`@cairn/sdk` also carrying a `prepare` script, it sometimes ran before
`@cairn/core`'s had finished, failing with "Cannot find module
'@cairn/core'". `.github/workflows/ci.yml` builds `@cairn/sdk` as its own
explicit step for the same reason.

`npx playwright install chromium` once, if you're touching crawl mode
(`packages/indexer/src/crawl.ts`) — it launches a real headless browser.

## Before opening a PR

```bash
npm run typecheck
npm test
npm run determinism   # L1's static scan must be byte-identical across two runs — no API key needed
```

CI (`.github/workflows/ci.yml`) runs the same three, plus building
`@cairn/indexer` (the `cairn` CLI ships as compiled JS so it runs
standalone — see the comment in that workflow for why).

An LLM-calling change (anything touching `l3-describe.ts`, `crawl.ts`,
`server.ts`'s prompt, etc.) needs `ANTHROPIC_API_KEY` or `GROQ_API_KEYS`
to actually exercise live — `npm test` uses fakes/mocks for these (see
`l3-describe.test.ts`, `server.test.ts`) so CI never needs a real key, but
a prompt change is worth running against the real thing at least once
before merging. This repo's own history is full of exactly that pattern —
check a recent commit for what "live-verified" usually looks like here.

## Where things live

See the README's "Repo layout" section — `packages/core` (schema),
`packages/indexer` (the `cairn` CLI: static scan, crawl mode, `init`),
`packages/sdk` (`<Copilot/>`, `<cairn-widget>`, server handlers, realtime
voice relay).

## What this project cares about, concretely

- **The verb contract never gets loosened casually.** `@cairn/core`'s
  `VerbResponseSchema` is the one thing standing between an LLM output and
  a real DOM action — see `resolveVerb` in `packages/sdk/src/server.ts`
  and its tests for what "never trust the client alone" actually means in
  code, not just in a comment.
- **A lookup failure degrades to explaining, never to guessing.**
  `findElement`'s ladder (`packages/sdk/src/element-ladder.ts`) returning
  `null` is a valid, expected outcome — every caller handles it by
  degrading, not by falling back to some other lookup.
- **Framework-agnostic code stays framework-agnostic.** `element-ladder.ts`,
  `verb-executor.ts`, `context-collector.ts`, and the server handlers in
  `packages/sdk/src/server.ts`/`realtime-server.ts` have zero React/Next.js
  imports on purpose — that's what makes `<cairn-widget>` (Phase 1) and
  crawl mode (Phase 2) possible without forking any of that logic. If a
  change to one of these files needs to import something React- or
  Next-specific, that's a sign it belongs in `index.tsx` instead.

See [ROADMAP.md](./ROADMAP.md) for the current state of "any framework"
support and what's still open — auth-gated apps and SPA-only client-side
routing aren't handled by crawl mode yet (`packages/indexer/src/crawl.ts`,
covered by `crawl.test.ts` for the cases that already work); a
contribution there is very welcome.

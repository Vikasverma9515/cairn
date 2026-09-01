# Development history

This file exists to prevent one specific mistake: **this repo contains two
separate things**, and it's easy to mix them up — even for the people
working on it. Read this before assuming a feature described anywhere in
this repo belongs to "Cairn the product."

## The two tracks

| | Track A — **Cairn**, the product | Track B — the structure graph (R&D) |
|---|---|---|
| What it is | An AI agent that lives inside *someone else's* app and actually uses it for the customer — clicks, fills forms, runs a flow — while they just say what they want. | A separate Python backend that parses a codebase (10 languages) into a queryable graph and hands it to *AI coding agents* over MCP. |
| Lives in | `packages/core`, `packages/sdk`, `packages/indexer`, `examples/demo-app` | `services/graph` |
| Language | TypeScript | Python |
| Built for | Companies embedding Cairn in their product, and their end customers | AI coding agents exploring a codebase — not an end customer |
| Is this the landing page? | **Yes.** `site/index.html` and the root [README.md](./README.md) describe this. | No. Not customer-facing, no landing page, no install pitch. |
| Status | Working end to end, MIT licensed, real install docs. | Working, real tests, never shipped to a customer — an internal exploration. |

They share a repo because Track B started as a question: could the same
"read code → build a graph → expose it safely" idea also power a second
product — AI coding agents operating on Cairn's *own* codebase? It's real,
tested code, not a stub — it's just a different thing than what Cairn
markets itself as today. If you're writing copy, a pitch, or a landing
page for Cairn, it describes **Track A only**.

---

## Track A — Cairn, phase by phase

The product: read an app's source once, then let an agent explain,
highlight, navigate, and *act* inside it, live, driven by conversation.

1. **Scaffold.** The monorepo, the L1→L2→L3 pipeline (AST scan →
   reachability → LLM description), the runtime SDK, a demo app, tests,
   CI.
2. **First real backlog clear.** A second LLM provider (Groq, alongside
   Anthropic), Next.js Pages Router support, a failure-tracking dashboard,
   the first voice pass, a `diff` tool, a docs generator.
3. **Persistence.** Real SQLite storage for the demo app, replacing an
   in-memory stub.
4. **Voice, for real.** Text-to-speech, then a full real-time voice
   conversation — streaming TTS over a persistent WebSocket instead of a
   buffered clip, barge-in (talk over it and it stops), a guided
   multi-step "tour" verb, cross-page tours, conversation memory,
   capability tiers (`explain` / `guide` / `act`), a configurable persona.
5. **Phase 0 — publishable package.** Made it installable as a real
   package instead of only working inside its own monorepo.
6. **Phase 1 — framework-agnostic widget.** A Web Component
   (`<cairn-widget>`) that works in Vue, Angular, Svelte, or plain HTML —
   not just React.
7. **Phase 2 — crawl-mode analyzer.** `cairn build <url>` reads a
   *running* app with a headless browser instead of source — works on any
   framework's output, not just Next.js.
8. **Phase 3 — `cairn init`.** Scaffolds the backend route for any
   detected framework.
9. **Phase 4 (partial) — open-source polish.** CONTRIBUTING.md, issue
   templates, CI already in place.
10. **Scaling pass.** Parallelized the description-writing step for large
    codebases; a page that fails now degrades and retries instead of
    silently breaking the whole build.
11. **Ongoing.** UI/UX iterations on the widget itself, and real bugfixes
    found by dogfooding (voice getting stuck, duplicate audio, a
    fire-and-forget handler that could strand a live call).

**`cairn setup` (new).** A one-command onboarding wizard, added after
`npm install @cairnvibe/core @cairnvibe/sdk @cairnvibe/indexer` plus
manual layout edits turned out to be real friction. Two real bugs found
by testing against an actual project (VOXERA, not a synthetic fixture)
and fixed, not just noticed:
- Turbopack failed cold ("Unknown module type") on `@cairnvibe/sdk`'s
  raw `.tsx` entry with no `transpilePackages` configured — `setup` now
  adds it to the consuming project's `next.config.*` automatically (a
  real AST edit across the common config shapes, safe fallback on
  anything it can't confidently parse).
- Inserting `<Copilot onDo={...}/>` directly into `app/layout.tsx`
  broke with "Event handlers cannot be passed to Client Component
  props" — layout.tsx is a Server Component by default, and a function
  prop can't cross that boundary. Fixed by generating the same small
  `"use client"` wrapper component `examples/demo-app` already used
  correctly, instead of inlining `<Copilot/>` straight into the layout.

**Runtime prompt scaling (new, in @cairnvibe/sdk).** Found live against
VOXERA, a real ~17-page production app: the `/api/copilot` handler's
system prompt included every element on every page, on every single
request, regardless of which page the user was actually on. At real
scale that came to 12,402 tokens in one request — over Groq's 8000 TPM
limit — so no query answered at all, ever, on that app. Fixed by
splitting the prompt: a compact route directory (route + purpose only)
stays in the cached, route-independent system prompt; the current
page's real element detail now travels separately, per request, in a
new `currentPageElements` field. Verified against VOXERA's actual
manifest: the old approach measured ~12,643 estimated tokens, the fix
brings it to ~837 — real questions now get real answers, confirmed with
a direct `/api/copilot` call. `@cairnvibe/sdk` bumped to 0.2.0 (a real
breaking change to `resolveVerb`'s and `buildSystemPrompt`'s exported
signatures) and republished.

**Two more real bugs, found by hands-on testing against VOXERA (@cairnvibe/core 0.1.1, @cairnvibe/sdk 0.2.1, @cairnvibe/indexer 0.2.3):**
- A real, reproducible tour crash: Groq's `openai/gpt-oss-120b` sent
  `"target": null` for a tour step with nothing specific to point at —
  completely reasonable model behavior — but the tool schema declared
  `target` as `string`-only, so Groq's own strict validation rejected
  the *entire* tool call with a 400 before any code here even ran,
  degrading a real "what can you do on this page" question straight to
  a generic failure message. Fixed in two places: the tool schema sent
  to the model (`["string", "null"]` for every genuinely-optional
  field), and `VerbResponseSchema` itself (`z.preprocess` normalizing
  null to undefined) — Groq accepting null on the wire doesn't help if
  our own Zod parsing rejects it one layer later.
- Voice was completely unwired despite `cairn setup` collecting a real
  Deepgram key: `init.ts` never scaffolded `/api/copilot/speak` or
  `/api/copilot/transcribe` for a Next.js project (only the standalone-
  server path had them), and the generated `CairnCopilot.tsx` wrapper
  never passed `speakEndpoint`/`transcribeEndpoint` even when it did.
  Choosing "Deepgram" during setup did nothing beyond saving a key
  nothing ever read. Fixed: `runInit` and `injectWidget` both gained a
  `voice` option: `setup.ts` scaffolds the real speak/transcribe routes
  (copied from examples/demo-app's already-proven implementation) and
  wires the matching props into the wrapper, only when voice was
  actually chosen.

Both verified live, not just in isolation: a direct POST to VOXERA's
real `/api/copilot` with the exact crashing question now returns a real
tour; a direct POST to the newly-scaffolded `/api/copilot/speak`
returns real MP3 audio (14.5KB) from a real Deepgram call.

Full detail: [ROADMAP.md](./ROADMAP.md) (forward-looking, phase-by-phase)
and [BUILD_PLAN.md](./BUILD_PLAN.md) (original design).

---

## Track B — the structure graph, phase by phase

The R&D: give an AI coding agent a real map of a codebase instead of
letting it guess.

- **Month 1.** The structure graph itself — tree-sitter parsing, symbols/
  imports/call-edges in SQLite, dead-code detection. Started with
  TypeScript, then Python.
- **Month 2.** The permission gate — REVIEW/AUTO modes, CRITICAL-tier
  actions (delete a file, run a command) always need human approval, an
  audit log of every decision.
- **Month 3.** Multi-agent orchestration — a LangGraph planner routes
  each request to a scoped read/edit/exec specialist.
- **Month 4.** Per-customer memory, and a provider abstraction (swap LLM
  vendors without touching calling code).
- **Month 5.** Usage analytics, and one-command packaging.
- **Month 6.** A health-check ("doctor") command and CI for the Python
  service.
- **Interleaved with the above:** language support grew to 10 (TypeScript,
  JavaScript, Python, Go, Java, Rust, C#, Ruby, PHP); a dependency graph
  (the third index, alongside structure and semantic search); real Groq
  and Deepgram provider wiring; an analytics dashboard; a real external
  stress test against `microsoft/vscode`.
- **Month 7.** Fixed a real algorithmic bug in dead-code detection (76x
  less CPU work), plus vector-index throughput work.
- **Month 8.** The real voice loop, connected for the first time — speech
  in, routed, an LLM reply, speech out.
- **Month 9.** The agent loop — the LLM actually executes tools now, not
  just plans what it would do.
- **Month 10.** Cost control — real rate limits and cost ceilings,
  enforced before a call goes out.
- **Post-Month-10 verification pass.** A full build/test/self-review
  sweep across both tracks, not tied to a specific month: found and
  fixed a real packaging bug (Track A — `npm publish` was shipping raw
  test files inside `src/`), found and fixed a real security gap (Track
  B — `approved=true` on a gated action was an unauthenticated boolean
  the calling model controlled; now requires a matching `request_id`
  tied to a real, still-pending, same-action prior approval), documented
  (not silently fixed) that the multi-agent orchestrator's tool-scoping
  isn't actually wired into the MCP server's registered toolset yet, and
  closed the Month 7 open question on dead-code detection's wall-clock
  time — 48.877s on a machine with real disk headroom, confirming the
  earlier 6.7-minute number was environment-bound, not algorithmic.

Full detail: [services/graph/README.md](./services/graph/README.md).

---

## If you're not sure which track something belongs to

Ask: does this feature involve an end customer talking to an agent that
uses *their* software? → **Track A.** Does it involve an AI coding agent
querying a codebase's structure? → **Track B.** If a doc, a landing page,
or a pitch doesn't say which one it means, that's a bug in the doc — fix
it to say so explicitly, the way this file does.

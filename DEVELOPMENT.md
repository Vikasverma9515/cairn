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

**Real-time voice actually wired up, plus two more real bugs, found by
hands-on testing against VOXERA (`@cairnvibe/sdk` 0.2.2 → 0.2.5):**
- Full realtime voice conversation (not just push-to-talk) was
  unreachable even after `realtimeUrl` was set on the widget, because
  nothing was ever listening on that port — `cairn-realtime` is a
  separate, persistent relay process nobody started. Fixed with a new
  `--with "<command>"` flag on `cairn-realtime` itself: it spawns the
  given dev command as a child (mutual shutdown wiring — either process
  exiting takes the other down) and degrades gracefully — a missing key
  or manifest logs a warning and starts the companion anyway, never
  blocks the dev server — instead of the old hard-exit. `cairn setup`
  now rewrites the project's own `dev` script to
  `cairn-realtime --port 3010 --with "<original dev command>"` when
  voice was chosen, so one `npm run dev` is enough.
- That `--with` flag immediately surfaced a second, real bug: run as
  the *outer* process of its own `--with` pattern, `cairn-realtime`
  never saw Next.js's `.env`/`.env.local` auto-loading — that loading is
  scoped to Next's own process, not whatever spawned it. A real
  `DEEPGRAM_API_KEY` sitting in VOXERA's `.env` was invisible
  (`cairn-realtime: DEEPGRAM_API_KEY is not set.`) even though the exact
  same key worked fine for Next's own API routes a moment later. Fixed
  with a small, dependency-free `.env`/`.env.local` parser now called at
  the top of `main()` (never overrides a real, already-set
  `process.env` value — file contents only fill a gap). Caught on the
  first attempt that the parser function was written but never actually
  *called* — a real second bug in the same fix, found by re-running the
  same live repro rather than trusting the diff.
- The widget's caption UI held exactly one "current" exchange, silently
  overwritten the instant a new question started — reported live as
  "the next time I'm speaking is hiding." Fixed with a persistent,
  auto-scrolling transcript: the outgoing exchange is archived (faded,
  scrolled up) the moment a new one begins, instead of just vanishing.
  First version double-archived the tour-triggering question (a stray
  archive call at the top of `runTour` re-captured what `ask()`/the
  realtime "final" handler had already archived a moment earlier) —
  caught live in the browser, not by code review, and fixed by removing
  the redundant call.
- Tour steps with a `route` field (a walkthrough that spans more than
  one page) were suspected broken based on an earlier voice-testing
  report ("the guide only speaks, doesn't navigate"). Live testing found
  the opposite: both the LLM (a real multi-page tour request against
  VOXERA correctly returned steps with `route: "/admin/sessions"`,
  `route: "/admin/agents"`, etc.) and the client's `router.push` +
  highlight logic already worked — confirmed twice, driving a real
  browser through a real cross-page tour (`/` → `/demo`, tab title and
  URL changing on cue). The original report most likely predates the
  realtime-relay fix above: with nothing listening on `realtimeUrl`, a
  voice tour had no working path to test in the first place.

**A `do` action can now auto-execute for real, with zero manual
configuration** (`@cairnvibe/core` 0.1.3, `@cairnvibe/indexer` 0.2.6,
`@cairnvibe/sdk` 0.2.6). Previously "do" only ever worked for an action id
a developer had hand-listed in `registeredActions` — with none configured
(the common case), the system prompt told the model to never use the verb
at all. Now: if the model targets a real element from `currentPageElements`
whose own indexer-generated description says it performs an action,
`resolveVerb` looks that element up in the manifest server-side and, only
if it carries a real `apiCall` (the indexer's own static trace of a real
`fetch`/`axios` call in that element's handler), attaches it to the
response — never something the model invents. The client fires that exact
request through the browser's own session, highlights the target, and
reports failure honestly rather than claiming success. `registeredActions`
still works exactly as before and takes priority when both could apply.
Two real, necessary tightenings found while building this:
- `manifest.ts`'s `parseApiCall` used to accept *any* non-empty URL
  string, including l1-scan.ts's raw-source-text fallback for a per-row
  action's dynamic URL (e.g. a template literal like
  `` `/api/items/${id}/archive` `` capturing literal backticks and an
  unresolved `${...}` hole) — fetching that as-is would hit a garbage
  URL. Now only a clean, static, same-origin relative path is accepted;
  a dynamic per-row URL correctly yields `apiCall: null` (still
  explainable/highlightable, just not auto-executable — a real,
  documented gap for a future pass, not silently pretended away).
- `cairn build`'s own CLI had the identical `.env`-loading gap
  `cairn-realtime` did (see below) — a local `npx cairn build` or
  `npm run build` couldn't see a real `GROQ_API_KEYS`/`ANTHROPIC_API_KEY`
  sitting in `.env`. Fixed the same way, verified live: re-running the
  exact same VOXERA build that previously skipped ("no key set for
  groq — skipping") now completes and finds 15 real, auto-discovered
  actions across the app (an "End Call" button, several form
  submissions, a settings save, etc).
Verified live end-to-end, not just server-side: asking VOXERA's real
`/demo` page widget "please click the end call button right now" resolved
to a real `do` verb with `apiCall: {method:"POST", url:"/api/session/end"}`
attached, and the browser's own network log confirmed the widget actually
fired `POST /api/session/end` (a real 401 — no session was active in the
test browser — reported back to the user rather than papered over).

**Four real voice-conversation bugs, found by hands-on realtime testing
against VOXERA** (`@cairnvibe/sdk` 0.2.5 → 0.2.6):
- **The core one: the agent spoke twice, in parallel, and the transcript
  showed duplicate entries with no reply in between.** Root cause: the
  realtime relay treated every Deepgram `is_final:true` Results message as
  a finished question — but `is_final` only means "this transcript chunk
  won't be revised," not "the user stopped talking." A single continuous
  utterance can finalize in several chunks with no real pause between
  them, each one triggering its own independent LLM+TTS turn. Fixed by
  accumulating `is_final` chunks and only actually resolving a turn on
  `speech_final:true` (the real endpointing-detected pause), with
  Deepgram's separate `UtteranceEnd` event as a fallback so a turn can
  never get stuck with unflushed buffered text. Also closed a related gap
  while in there: a barge-in that lands *while* the LLM call for a turn is
  still in flight now drops that turn's now-stale verb/speech once it
  finally resolves, instead of letting it land on the client after the
  user already moved on.
- The mic was completely deaf during "thinking" (the gap between the
  user's question finishing and the agent's reply starting) — only
  "speaking" had a barge-in path. An LLM turn can easily take a couple of
  seconds with nothing playing yet; reported live as "not listening while
  speaking... no interrupting system." Fixed by extending the same RMS
  barge-in check to "thinking" too.
- A tour ("guide") could not be interrupted at all, by design — talking
  during a step was silently ignored. Changed on explicit request: a real
  interruption now cancels the rest of the tour immediately and returns to
  listening, the way a real person giving a tour stops when you ask
  something instead of continuing to talk over you.
- A tour step whose server-side narration failed could hang for a full 15
  seconds (its own fallback timeout) with zero signal to the user, and if
  it kept failing, every remaining step would too — read as "the guide
  goes quiet for long stretches" or "can't speak after the guide is
  done." Fixed in two places: the "speak" WebSocket handler now catches a
  failure and sends a real error message instead of an unhandled
  rejection nobody hears about, and the client's error handler now
  resolves the current step's pending promise immediately instead of only
  ever recovering via the timeout.
All four verified with new, real unit tests exercising the actual message
sequences (two `is_final` chunks for one utterance → one turn, not two; a
barge-in mid-resolve → the stale verb never reaches the client) — a full
live audio round-trip couldn't be exercised in this environment (no real
microphone available), so the fixes are verified at the protocol/logic
level, not yet confirmed by ear.

**Runtime DOM awareness — the agent can now see and click what's actually
on screen** (`@cairnvibe/core` 0.1.3, `@cairnvibe/indexer` 0.2.6,
`@cairnvibe/sdk` 0.2.6). The manifest is a build-time snapshot: it can only
ever know about elements a developer manually tagged or that existed in
source at scan time. Two concrete, real failures came from this — VOXERA's
Sessions list (each session a `<div>`/card with no per-item id — the
indexer sees the list container, never a specific row) and its Agent
Builder's "New Agent" button (reveals a form, no `fetch` call at all, so
the `do` verb — which only knew how to fire a raw apiCall — had nothing to
attach and correctly refused every time). Fixed with a genuinely new
capability, not a patch to the old one:
- New `packages/sdk/src/runtime-scan.ts`: a live DOM scanner running
  continuously in the background via a debounced `MutationObserver` (never
  a per-request scan-and-wait — the element map is always already warm),
  finding real interactive elements — `data-ai`-tagged or plain
  `button`/`a`/`role=button` — currently in the viewport, each with a real,
  bounded snippet of its actual visible text (~80 chars, capped element
  count). This is the one deliberate reversal of an explicit prior design
  decision (`context-collector.ts`'s "never send page text, only ids") —
  confirmed with the user before building it — because there's no other way
  to let the agent address "the session with the Fear badge" or describe
  what a dynamically-rendered list actually contains.
- The manifest's own static elements still exist and are still used first
  where they apply — this is additive, a fallback for what the build-time
  scan structurally can't see, not a replacement.
- `do`/`open` became click-first instead of fetch-first: the client now
  tries to resolve the real element (via the live scan or the existing
  static ladder) and calls a real `el.click()` — the actual button's own
  handler runs in full (local state, spinners, anything beyond a network
  call), which is also the only way to fire an action that has no `fetch`
  at all. The previously-only path (constructing and firing the raw
  `apiCall` directly) is now strictly a fallback for a target that can't be
  resolved live right now (e.g. it's on a page reached earlier in the
  conversation) — never fired in addition to a real click, so nothing runs
  twice.
- Tours gained an optional per-step `click: true` so a guided walkthrough
  can actually demonstrate ("I'll open Sessions and click into one") rather
  than only ever highlighting and describing.
- `examples/demo-app` gained two new pages purpose-built as regression
  tests for exactly these gaps (a Sessions list with no per-row id, an
  Agent Builder button that only reveals a form) and its `dev` script was
  folded into the same `cairn-realtime --with "next dev"` single-command
  pattern already shipped for VOXERA, since fighting VOXERA's own
  competing voice-agent UI and auth was making it an unreliable place to
  verify realtime-specific fixes.
- A real, unrelated setup bug surfaced while wiring `demo-app` back up:
  its `package.json` still pinned `@cairnvibe/sdk`/`core` to `^0.1.0`, a
  semver range that (per 0.x rules) no longer matched the current `0.2.x`/
  `0.1.3` local packages — so npm workspaces silently fell back to
  installing a real, stale registry copy instead of symlinking the local
  source, and `demo-app` had been testing against months-old code without
  anyone noticing. Fixed by bumping the ranges to match; `npm ls` now shows
  every workspace correctly deduped to `./packages/*`.

Verified live end-to-end (not just server-side, and not just unit tests —
177 passing, but the real proof is a real browser): on `demo-app`, "open
the session with the fear emotion" correctly highlighted and clicked that
exact card (the page's own selection state updated, detail panel
populated); "create a new agent for me" clicked the real "New Agent"
button and revealed its form; a tour step with `click: true` clicked the
real per-row Archive button for one specific invoice (a dynamic
`/api/invoices/${id}/archive` URL — never auto-executable via the old
apiCall-only path) and the app's own handler ran in full, invoice status
flipping to "Archived" and the page reloading exactly as a real manual
click would.

**Compact panel by default** (same `@cairnvibe/sdk` release): the
transcript persisted from the prior session's fix but was always shown
inline, growing the panel uncomfortably tall over a longer conversation —
reported as "too big." Now collapsed by default (only the current
exchange shows), with a small "N earlier" toggle to expand the full
archived history on demand.

**A real agent loop, not a single fixed verb per question**
(`@cairnvibe/core` 0.1.4, `@cairnvibe/sdk` 0.2.7). Every prior design —
including everything above — resolved one question to exactly one action
and stopped: no way to check something, decide, then act, no parameters
beyond a fixed set of known elements. Explicit ask: an agent that can
actually reason and operate the app, not a five-way classifier. Researched
first, not guessed at — Anthropic's own Computer Use, OpenAI's Realtime
API, the `browser-use` framework, and how production voice-agent companies
split "fast talker" from "slow reasoner" — three findings shaped this:

1. **[WebMCP](https://webmachinelearning.github.io/webmcp/)** — a real,
   in-progress web standard (`document.modelContext.registerTool()`) for a
   page to expose its own functions as typed tools an agent calls
   directly, in the page's own session. Better than anything inferred from
   static analysis: a real function with a real return value, written by
   the app's own developer. New `packages/sdk/src/webmcp-client.ts`
   discovers these tools client-side and reports them to the server each
   turn (`CopilotRequestSchema.webMcpTools`) — a no-op everywhere the
   standard isn't implemented yet (currently: everywhere, no browser ships
   it natively), so this is additive, never a dependency.
2. **The loop itself stays minimal** — `browser-use`'s own published
   philosophy ("the less you build, the more it works") argued against a
   bespoke planning/verification layer: just call tools until the model
   signals it's done, with real observations fed back each step. Four new
   verbs carry this: `click`/`fill`/`read` (act on or read a real,
   already-discovered element) and `call_tool` (call a real WebMCP tool by
   name) — all *continuing* steps (`TERMINAL_VERBS` in `@cairnvibe/core`
   says which verbs, like `explain`/`do`/`tour`, end the turn instead).
   Every target still has to be a real id from the manifest, the live DOM
   scan, or this turn's own WebMcpTools list — the loop adds multi-step
   reasoning, it doesn't relax "never invent a selector."
3. **Talker/Reasoner is a real, named production pattern** (confirmed via
   Sierra's and others' published latency engineering, and OpenAI's own
   Realtime API update: "the model can continue a fluid conversation while
   waiting on results") — not attempted this pass (a real next step, once
   this foundation is proven), but it's *why* the loop had to exist first:
   there's no multi-step work to hand a "worker" until the loop itself
   does something.

Where the loop actually lives, since a server can't execute a DOM action
itself: `resolveVerb` (`server.ts`) stays the single-call primitive it
already was, now also validating the four new verbs' targets the same way
`do` already was. The *loop* is driven by whoever holds the turn's
continuity — `index.tsx`'s new `runTypedAgentLoop` for the stateless HTTP
path (resending accumulated history each call, the same pattern `ask()`
already used), and `realtime-server.ts`'s rewritten `finalizeTurn` for the
realtime path (a real `tool_result` WebSocket message and a
`waitForToolResult()` pause/resume, following the same "mutable pending-
callback slot" pattern the file's own barge-in handling already used) —
capped at 6 steps either way, degrading to an honest "wasn't able to
finish that" rather than looping forever.

Verified live end-to-end on `examples/demo-app` (extended with a real
`document.modelContext.registerTool()` call and — since no real browser
implements WebMCP yet — a small demo-only polyfill, clearly labeled as
such, purely to exercise the real API shape ahead of native support):
asking "how many invoices are overdue right now" correctly resolved to
`call_tool`, executed the real registered function, and answered "There
is currently one overdue invoice, from New Client" — the real count, from
the real function, not a guess. The pre-existing single-step paths
(click-to-select on the sessions page) were re-verified unchanged
afterward — the new terminal/continuing split didn't regress the fast
path it's built alongside.

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

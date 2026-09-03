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

Next pass, working down the same architecture's remaining items one by
one: Talker/Reasoner for realtime voice (deferred above), a Groq
tool-call-parsing robustness fix, then speeding up the buffered speak
path — the last one turned up a second, more consequential bug.

- **Talker/Reasoner, for real this time.** `realtime-server.ts`'s
  `finalizeTurn` now speaks a quick, rotating acknowledgment
  ("Let me check that for you.", etc.) the moment a turn needs more than
  one loop step — not on every step, just once, before the real answer —
  while the loop keeps working in the background. A single-step turn
  (the common case) never triggers it, so the fast path gets zero added
  latency. A barge-in landing during the ack itself is still honored
  (checked again before the real answer speaks).
- **Groq `output_parse_failed` retry.** Found live in a real VOXERA log:
  Groq's `openai/gpt-oss-120b` occasionally reasons in prose instead of
  emitting the forced tool call, which surfaced as "not reasoning, not
  answering" from the outside. `GroqVerbLLM.respond()` now retries once,
  specifically for that error code — any other error still throws
  straight through.
- **The buffered (non-realtime) speak route was slow for a real,
  root-caused reason, not a vague one.** `speak-server.ts` did
  `await response.arrayBuffer()` against Deepgram's REST endpoint —
  nothing played until Deepgram rendered *and* the network delivered the
  entire reply, measured at 5-8s in a real production log. This is the
  same class of bug the realtime path already fixed once; it just hadn't
  been applied to this separate code path. Fixed the same way: `speak-
  server.ts` now opens Deepgram's streaming Speak WebSocket (the same
  `DeepgramSpeakStream` class the realtime path already uses) and
  returns a `ReadableStream` of raw PCM chunks as they render, instead of
  a buffered `ArrayBuffer` — a real breaking change to the `/speak-
  server` export, updated everywhere it's consumed (`packages/indexer`'s
  three scaffolded route templates — App Router forwards the stream
  natively; Pages Router and the standalone Express server both need
  `Readable.fromWeb(stream).pipe(res)`). Splitting the outgoing text into
  sentence-sized `Speak` messages before one `Flush` was a second win
  from the same change: it also sidesteps Deepgram's REST-only
  2000-character cap, a separate bug from the same log (a 413 on a long
  reply, previously unhandled).
  - **Streaming the wire alone isn't the fix — verified this the hard
    way.** `fetch()`'s `.blob()`/`.arrayBuffer()` always wait for the
    complete response body in every browser, no matter how the server
    sent it. `index.tsx`'s `speak()`/`speakAndWait()` had to be reworked
    too: they now read the response via `res.body.getReader()` and
    schedule raw PCM16 chunks gapless-appended into a Web Audio API
    graph as they arrive — reusing the exact scheduling technique the
    realtime path already used for its own `audio_chunk` messages, just
    fed by a fetch stream instead of WebSocket frames.
  - **A second, separate bug this surfaced: `ws` silently breaks under
    Next.js's dev bundler.** Live-testing the rewrite against
    `examples/demo-app` — direct calls to the compiled handler worked in
    under 3s, but the same code called through the actual Next.js API
    route hung for ~10s and failed with `ECONNRESET`, every time. Root
    cause: demo-app's `next.config.js` sets `transpilePackages:
    ["@cairnvibe/sdk", ...]` (needed so the client widget's raw-TS
    export gets a proper SWC pass), which also pulls the `ws` package
    into webpack's bundle graph — and a webpack-bundled `ws` can't
    reliably hold a Deepgram WebSocket open. Fixed by adding `ws` to
    `serverExternalPackages` alongside `better-sqlite3` (already handled
    the same way, for the same reason). Since any real consumer app that
    transpiles `@cairnvibe/sdk` and enables voice would hit this exact
    failure, `cairn init --voice` now prints the same fix as a next
    step, not just demo-app's own config.
  - **Verified live, not just unit-tested:** a direct streamed fetch
    against demo-app's real `/api/copilot/speak` (real Deepgram key, no
    mocks) delivered 184 real PCM chunks over 5.4s total, first chunk at
    ~2s — versus the old behavior of zero bytes until the entire ~5.4s
    reply was ready. Then re-verified through the actual widget UI
    (typed question → real navigate answer, four real 200 responses from
    the speak endpoint, no playback errors in console).

Next item down the list: the live scanner's viewport-only limitation. This
one live-testing session turned up two more real bugs along the way,
both a lot more consequential than the feature itself.

- **`runtime-scan.ts` no longer hard-filters to what's on screen right
  now.** An element below the fold, or in an unscrolled panel, was
  completely invisible to the agent before — not just hard to reach, not
  discoverable at all, even though `highlightElement` already
  `scrollIntoView`'d before acting, so execution was never actually the
  problem. Fixed by ranking candidates by distance from the current
  viewport (0 for on-screen) instead of dropping anything outside it —
  on-screen still wins every tie, off-screen fills whatever room is left
  under the cap (bumped 40 → 50, still under `CopilotRequestSchema`'s 60
  limit). A `display:none` element (an all-zero rect) is still excluded —
  that's "not rendered," a different question from "off-screen." First
  real unit tests for this file (it had none): 6 cases covering ranking,
  the display:none exclusion, and cap behavior.
- **A real bug this surfaced, unrelated to scanning itself: Groq's own
  structured tool calling 400'd on `text`/`steps`.** Live-testing the
  scan fix (asking to archive an off-screen row) hit a real
  `tool_use_failed` 400 — Groq rejected `"text": null` and
  `"steps": null` outright, because those two fields, alone among the
  tool schema's optional properties, were plain `"string"`/`"array"`
  instead of the nullable-union treatment (`["string", "null"]`) every
  *other* optional field already got, for exactly this reason, in an
  earlier batch. A model filling in the wire schema's every declared
  property (`null` for whichever don't apply to the verb it picked) is
  routine, not an edge case — `text` and `steps` had just been missed.
  Fixed in `buildVerbToolSchema`.
- **A second, more serious bug found chasing the first: every verb
  variant in `VerbResponseSchema` was `.strict()`, and the wire schema is
  ONE flat object shared across all of them.** Once the fix above let
  Groq actually return a full flat response — `{verb:"click",
  target:"...", text:null, route:null, action:null, value:null,
  name:null, args:null, steps:null}` — `.strict()` rejected it outright
  as "unrecognized keys," since a `click` response's own schema only
  ever declared `verb`/`target`/`text`. This silently degraded a working
  tool call to "I'm not sure how to help with that" — and would have hit
  *any* verb, not just click, any time the model filled in enough of the
  flat schema's other fields. Fixed by giving each variant a shared
  `COMPANION_FIELDS` spread (every other verb's fields, nullable) before
  overriding with its own real constraints — `.strict()` still rejects a
  genuinely unexpected key (the existing "sql: DROP TABLE users"
  injection-defense test still passes unchanged), it just no longer
  chokes on the other verbs' own known fields showing up as null.
- **Verified live, the real way — not a mock:** shrank the browser
  viewport so the "New Client" row's Archive button fell below the fold,
  asked the widget (over real Groq) to "archive the invoice for New
  Client," and watched a real two-step agent loop run end to end: `read`
  the (now-discoverable) invoice table to identify the right row, then
  `click` its Archive button — firing a real `POST
  /api/invoices/.../archive`, confirmed by the row showing "Archived" on
  reload. Every layer of this fix chain (viewport ranking, the nullable
  wire fields, the companion-fields schema) was necessary for this one
  exchange to work; any single one missing would have broken it the same
  way it did on the first attempt.

Next item: non-semantic clickable elements — a `<div onClick>` or
`<span onClick>` styled as a button, with no `<button>` tag, no `role`,
no `data-ai`. Common in component libraries, and exactly the shape
behind VOXERA's original "Agent Builder's New Agent button does
nothing" report from earlier this session (that one turned out to be a
real button; this fix targets what a genuinely non-semantic one would
have needed).

- **`runtime-scan.ts` now finds these too**, via a second pass over
  every element the CSS-selector pass didn't already catch, checking
  each for a real click handler — `el.onclick` for the plain-JS case, or
  React's own per-node `__reactProps$.../__reactEventHandlers$...` key
  (every React-managed DOM node carries one) for a JSX `onClick` prop,
  since React never writes an `onclick` HTML attribute a selector could
  match. Reported with role `"clickable"` rather than a bare "div",
  which tells the model nothing. Execution needed no changes at all —
  `el.click()` (verb-executor.ts) already dispatches a real bubbling
  `MouseEvent`, which fires a React synthetic handler exactly the same
  as a real `<button>` would; discovery was the only actual gap, same
  story as the viewport fix above. 5 new unit tests, including the
  React-props-key detection and confirming a real `<button>` never gets
  double-counted through the fallback pass.
- **Verified live, the real way:** made `examples/demo-app`'s Agent
  Builder cards genuinely non-semantic (`<div onClick>`, no button/role/
  data-ai — confirmed via `Object.keys()` against the real page that
  `__reactProps$b4wk4hapip8` really does carry a live `onClick`), asked
  the widget "select the KAI agent," and watched it discover the card as
  `live-12`, click it for real, and the card highlight with "Selected:
  KAI" appearing below the list.

Last item on this pass: batched multi-action loop steps — the remaining
piece from the original architecture plan (Layer 2's "batch of
actions" idea, not attempted in the first pass). Modeled directly on
Anthropic Computer Use's own move to batched multi-action turns:
several sequential actions in one model response instead of one
network round trip per action, when the model already knows what it
needs to do without waiting to see each step's result first.

- **A new `batch` verb** (`@cairnvibe/core`) carries 2-5 of the
  existing click/fill/read/call_tool shapes in one `actions` array —
  continuing, not terminal, so it drops straight into the existing loop
  architecture with zero changes to either loop driver's control flow
  (`index.tsx`'s `runTypedAgentLoop`, `realtime-server.ts`'s
  `finalizeTurn`): both already gate purely on `TERMINAL_VERBS.has(verb)`,
  never on a specific verb name, so a brand new continuing verb "just
  works" the moment `verb-executor.ts` knows how to execute it. That
  turned out to be the real payoff of last pass's terminal/continuing
  split — this is exactly the kind of extension it was built to absorb
  without touching the loop itself.
- **Caught before it shipped: the exact same flat-schema bug, one level
  deeper.** `BatchActionSchema`'s own 4 variants were `.strict()` with
  only their own real fields — the identical class of bug the top-level
  `COMPANION_FIELDS` fix caught earlier this pass, just inside the new
  `actions` array instead of at the top level. Caught by directly
  testing the real flat shape Groq would actually send
  (`{verb:"click", target:"...", value:null, name:null, args:null}`)
  before ever running it live — fixed the same way, a
  `BATCH_ACTION_COMPANION_FIELDS` spread scoped to what the wire schema
  actually declares for a batch action.
- **Execution stops at the first failure** rather than continuing to
  act on a page state the model's plan didn't actually anticipate —
  each action's target/tool-name is validated up front too
  (`resolveVerb`), against the SAME real state check click/fill/read
  already use, so a batch with one invented target refuses the whole
  turn instead of guessing which of the rest were "safe enough" to run.
- **A stale doc bug fixed in passing:** the system prompt still told the
  model liveElements "only covers what's currently visible in the
  viewport" — no longer true since the viewport-ranking fix earlier
  this pass. Corrected to describe the real, current behavior (ranked
  by distance, not filtered).
- **Verified live:** asked the widget (over real Groq) to select two
  agent cards in sequence on a page with no dependency between the two
  clicks — the model genuinely emitted a real `batch` with both clicks,
  executed for real (confirmed the transcript rendering "(2 steps:
  click, click)" and the second card ending up correctly selected, the
  real intended outcome). One honest, non-code-level nuance surfaced in
  the same test: the model itself sometimes doesn't recognize the task
  as done right after a batch and keeps looping until the iteration cap
  — the batch mechanism executed correctly either way, and the cap's
  existing safety net degraded honestly rather than hanging, exactly as
  designed; this reads as a model-reasoning/prompt-tuning question, not
  a mechanism defect, and is left as a known nuance rather than chased
  further this pass.

This closes out every item from the original "whats pending" list
except Cairn as a WebMCP *producer* (Layer 4 — scaffolding real
`registerTool()` calls into a target app's own source), which the
approved plan explicitly deferred as separate future work, and the two
items that need the user directly (real microphone audio, VOXERA's own
admin-gated click-through).

**Layer 4, picked up next: Cairn as a WebMCP producer.** Everything
above was Cairn *consuming* WebMCP tools a page already registered.
This is the other half — `cairn build` already traces real, safe,
mutating actions statically (l1-scan.ts's findApiCallIn: a real
POST/PUT/PATCH/DELETE an element's own handler already makes, GET
deliberately excluded, never invented) but never did anything with
that beyond feeding Cairn's own runtime. A new `cairn webmcp <dir>`
command turns that same traced set into real
`document.modelContext.registerTool()` calls — so running Cairn's
indexer also makes the app agent-ready for *any* future agent that
understands the standard, not just Cairn, with zero Cairn lock-in (the
generated file has no Cairn import at all).

- **`packages/indexer/src/webmcp.ts` (new)** — pure codegen from an
  already-built manifest (same shape as `docs.ts`'s
  `generateDocsMarkdown`, no LLM call): one real, self-contained "use
  client" component, one `registerTool()` call per apiCall-backed
  element, named `<route>-<id>` for disambiguation. Wired into the CLI
  as `cairn webmcp <dir>`, writing `components/CairnWebMcpTools.tsx` —
  same "reads ui-manifest.json, writes a derived file" pattern `cairn
  docs` already established.
- **A real bug a unit test caught before it ever ran live:** element
  ids are only unique WITHIN a page (l1-scan assigns them per-page), so
  a first pass that deduped by id alone silently dropped any
  apiCall-backed element whose id happened to collide with another
  page's — confirmed by a test with two different pages each having
  their own "archive" element and only one surviving. Fixed by deduping
  on (id, method, url) together instead of id alone — that combination
  is what actually distinguishes "the same global element, seen once
  per page it's reachable from" (assembleManifest spreads framework-
  level elements onto every page) from "two unrelated actions that
  happen to share an id."
- **Verified live, full round trip:** ran `cairn webmcp` against
  `examples/demo-app`'s real manifest, wired the generated component
  into its root layout, confirmed `document.modelContext.getTools()`
  reported the real tool and calling it directly fired a real `POST
  /api/invoices` (201) — then, separately, asked the widget itself
  (Cairn's own *consumer* side, over real Groq) to create an invoice
  and watched it independently discover and call the exact same
  generated tool (`(called invoices-create-invoice)` in the transcript,
  a new row appearing in the real UI) — producer and consumer
  interoperating for real, not just compiling.

---

## Foundation: an eval + playground harness, and the real voice regression it found

The prior batches shipped voice changes (Talker ack, streaming TTS, the
agent loop) an entire session without ever once hearing them run — every
verification was a unit test with mocked STT/TTS/LLM clients, or typed-
text testing through the widget. That's the actual root cause behind a
real "voice keeps breaking" report: there was no harness that exercised
the full realtime path end to end, so a regression shipped invisibly
until a real user hit it. Before touching architecture further, built the
thing that closes that gap — and used it immediately, live, the way it's
meant to be used.

Full research (Anthropic's multi-agent research-system writeup, this
repo's own Track B orchestrator/agent-loop/memory code, a real-time voice
architecture primer, and current computer-use/long-horizon GUI agent
papers — CODA's Cerebrum/Cerebellum split, a vision-based task-completion
judge, Agent S2/ROMA/UI-TARS/Skyvern) is in the approved plan; the
concrete architecture direction it points to (a Planner/Executor/Critic/
Talker redesign, a real-time streaming upgrade, deep runtime context,
memory) is scoped as its own follow-on work, each phase getting its own
plan-and-approval pass in turn, the same way every other piece of work in
this file has.

**`packages/evals` (new)** — a real, never-published harness:

- **Playground apps** — a new node-based workflow builder
  (`examples/demo-app`'s `/workflows`, real SQLite-backed nodes/edges,
  the n8n-shaped genre from the plan) alongside the existing CRUD pages,
  chosen because it stresses canvas-style multi-step, stateful goals
  together — the combination the eventual multi-agent redesign most
  needs to be measured against. Deliberately scoped to click/fill/select
  interactions for now, not free-form drag-and-drop — Cairn's agent loop
  has no "drag" verb yet, so testing that now would only re-confirm an
  already-documented gap, not teach anything new.
  - **A real bug found building it**: the workflow page saved a field's
    config on `onBlur` — but `element-ladder.ts`'s `fillElement` (what a
    real Cairn `fill` action actually does) only ever dispatches
    `input`/`change`, never blur. A real agent-driven fill would set the
    value and never trigger the save. Fixed by saving on `onChange`
    instead, matching how a real fill actually happens.
- **`runScenario()`** — launches the real playground in a real Playwright
  browser with the real widget installed and drives a goal (plain
  language, never a click-here instruction) through **both transports**.
  The typed path just fills the real input and clicks Send; the voice
  path fakes the microphone at the browser API level
  (`navigator.mediaDevices.getUserMedia`, overridden to play back real
  pre-synthesized speech through a `MediaStreamAudioDestinationNode`)
  and clicks "Start realtime conversation" — Cairn's own real client
  code (mic capture, downsampling, the WS protocol, tool execution, audio
  playback) runs completely unmodified either way; the harness only ever
  *observes* network round trips and real WebSocket frames, never
  reimplements the protocol.
- **`judgeScenario()`** — Claude as judge, scoring task success against
  the app's own real final state (never the agent's own claim), plus
  efficiency, correctness, safety, and (voice runs) per-stage latency
  against the primer's stage budget.
- **Storage + regression tracking** — every run's full trace, verdict,
  and real per-stage latencies land in SQLite (`packages/sdk/src/
  dashboard-sqlite.ts`'s pattern), and `npm run evals` prints a score/
  latency diff against the previous commit's run of the same scenario —
  what runs before any future publish from now on.

**Three real bugs found building and dogfooding the harness itself — not
in the thing being tested, in the test infrastructure, each one a genuine
"the run silently proved nothing" failure mode:**

1. **The idle-clock started before the interaction it was supposed to
   measure.** `waitUntilQuiet`'s activity timestamp was initialized at
   function entry, before navigation/widget-open/the actual turn — by
   the time the wait loop ran (often already 1-2s later), it looked
   like the run had already been quiet long enough, closing the browser
   before the real async response ever arrived. Every early run reported
   zero network activity captured, even though the real turn had
   genuinely started.
2. **A short quiet-window mistook "still waiting on the next step" for
   "the whole loop is done."** A real two-step archive flow showed a
   ~10s gap between its "read" and "do" round trips under real Groq
   load; an 1.8s quiet threshold cut the run off after just the first
   step. Raised to 15s (with a 90s hard ceiling still catching a genuine
   hang) — found by watching a real multi-step trace complete correctly
   only once the window was wide enough to survive the gap.
3. **The WebSocket frame listener captured Next.js's own dev-mode HMR
   socket instead of (or drowning out) the real cairn-realtime
   connection**, plus a separate one where Playwright's function-
   serialization for `addInitScript` emitted a broken `__name(...)`
   helper reference for the fake-mic closure, throwing before
   `getUserMedia` was ever overridden — both silently produced "zero
   real voice activity" results that looked like a clean run instead of
   a broken harness. Fixed by filtering out framework noise from the
   socket listener and switching the fake-mic injection to a raw content
   string instead of a passed function reference.

**The real regression, found only once all three of the above were
actually fixed and the harness could observe a real run to completion:**
Groq's `openai/gpt-oss-120b` intermittently hallucinates a slightly-wrong
tool name — `"json"`, `"response_with_verb"` — instead of the one real
tool (`respond_with_verb`) it was actually forced to call. Groq's own
server-side validation rejects that with `tool_use_failed` /
`"attempted to call tool 'X' which was not in request.tools"` before
`resolveVerb` ever sees a response to work with, surfacing to the user
as a bare "Something went wrong on my end" with no other symptom — the
exact shape of "voice keeps breaking, stops mid-way" that got reported.
An earlier batch this session already added a retry for a *different*
Groq failure mode (`output_parse_failed`, the model reasoning in prose
instead of calling the tool) — this one was never covered, since the
error code and message are genuinely different. Fixed by broadening the
same retry (`isRetryableToolCallFailure`, `packages/sdk/src/server.ts`)
to also cover `tool_use_failed` with a hallucinated tool name — same
non-deterministic character as the original bug (an identical retry a
moment later gets the real tool name right), so the same one-retry fix
applies. Verified live: the exact synthetic-voice scenario that
previously produced "Something went wrong on my end" now answers "You
have three invoices" correctly, run after run.

### Status — foundation stage

**Built:**
- `packages/evals` (new, never published) — `runScenario()` (typed +
  voice transports, real Playwright, real fake-mic audio injection),
  `judgeScenario()` (Claude-as-judge against real final state),
  `store.ts` (SQLite run history), `cli.ts` (`npm run evals`, prints a
  pass/fail summary + score/latency diff vs. the previous commit's run).
- Workflow-builder playground: `examples/demo-app/app/workflows`, real
  SQLite-backed nodes/edges (`lib/workflows.ts`/`workflow-types.ts`),
  6 API routes, reachable at `/workflows`.
- 6 scenario fixtures in `packages/evals/src/scenarios/index.ts`
  (2 workflow-builder, 2 invoices CRUD, 1 typed-archive, 1 voice
  regression guard) — below the plan's ~20-scenario floor, an explicit
  starting point per lesson #1 (small samples are enough early signal),
  not a finished suite.
- `isRetryableToolCallFailure` in `packages/sdk/src/server.ts`
  broadened to cover the real `tool_use_failed`/hallucinated-tool-name
  regression, on top of the pre-existing `output_parse_failed` retry.

**Tests:**
- `packages/evals/src/runner.test.ts` — 8 real unit tests
  (`matchesExpectation`, `computeVoiceLatencies`), all passing.
- `packages/sdk/src/server.test.ts` — 2 new tests for the broadened
  retry (retries on the real hallucinated-tool-name error, does NOT
  retry an unrelated `tool_use_failed`), all passing.
- Full monorepo suite: 254/254 passing, all packages typecheck clean.
- Live-verified, not just unit-tested: all 6 scenarios run against a
  real demo-app + real Groq/Deepgram at least once; the voice-
  regression-guard scenario specifically run 3x in a row post-fix, 3/3
  succeeded with real, varying latencies (5.7s–18.3s total).

**Pending / not yet started:**
- Growing the scenario suite toward the ~20-scenario floor — only 6
  exist today, and only 2 playground genres (workflow-builder, CRUD) of
  the plan's larger list (canvas/design, marketplace, kanban).
- Human spot-checks on judge output (lesson #1's third eval layer) —
  only LLM-as-judge has run so far, never cross-checked by a human on
  any of these 6 scenarios yet.
- Phase 2 (real-time voice architecture upgrade: streaming the LLM
  answer into TTS, client-side fast VAD for barge-in, the Talker's
  actual persona) — scoped in the plan, not started. The streaming
  piece specifically needs a short design spike (three options listed
  in the plan) before implementation, not a guess.
- Phase 3 (Planner/Executor/Critic/Talker multi-agent redesign) — not
  started; explicitly waiting on Phase 1/2 to land first so it can be
  measured against the harness, not believed.
- Phase 4 (deep runtime context: data shapes, business rules/state
  machines, docs mining, unified tool inventory, dependency graph) —
  not started.
- Phase 5 (cross-session memory) — not started.

**Known gaps / did not fully solve:**
- The redundant-read behavior found live (run 1 of the reliability
  check: 4 repeated `read` calls before answering) — a real, observed
  instance of the "doesn't recognize task completion" failure mode from
  both pieces of research, left as-is on purpose. This is exactly what
  Phase 3's Critic role is designed to fix; patching it piecemeal here
  would fight the eventual real fix instead of measuring it.
- No CI wiring yet — `npm run evals` is a manual step today, not yet
  run automatically on a PR/pre-publish hook. The plan's "runs before
  any future publish" is a stated intent this session has started
  following manually, not yet an enforced gate.
- Only 1 of the two remaining `tool_use_failed`-shaped variants
  (`"json"`, `"response_with_verb"`) has a captured regression test with
  the *exact* live error string; the fix covers both by pattern
  (`attempted to call tool`), but only `"json"` has a dedicated unit
  test reproducing the literal observed error.

### Redesign: the eval/playground platform, on real published precedent

The 6-scenario, single-genre, CLI-only first pass proved the mechanics
but wasn't rigorous enough — explicit feedback after it shipped. Real
research this time (WebArena, BrowserGym, WorkArena/WorkArena++,
τ-bench, AgentRewardBench, production eval-platform UI patterns — full
citations in the approved plan) instead of continuing from first
principles. Working through the plan's 7-step build order one stage at
a time, each with its own tests and, where possible, live verification
— this entry covers steps 1-4.

**Built:**
- `taxonomy.ts` — 11 capability dimensions (`info-seeking`,
  `navigation`, `content-ops`, `multi-step-composite`, `unachievable`,
  `policy-constraint`, `ambiguous-clarify`, `non-semantic-ui`,
  `tool-use`, `voice-realtime`, `error-recovery`), grounded in WebArena's
  4-category taxonomy + τ-bench's policy/clarification dimensions.
  `Scenario.capabilities` is now required, not optional.
- `primitives/index.ts` — the "lego piece" registry (`PRIMITIVES`,
  `GENRES`), adapted from BrowserGym's standardized-environment-
  interface lesson to Next.js's real constraint (file-based routing
  can't register routes at runtime) — a primitive is a real
  reset/observe/capability contract, not a literal shared-component
  system. `scenarios/index.ts` now resolves its paths through this
  registry instead of hardcoding them.
- `templates.ts` — WebArena's template-to-variation scaling. The email
  and Slack workflow scenarios are now real templates (`{email}`,
  `{channel}` placeholders) with 2 variants each — suite grew from 5 to
  7 scenarios by adding variants, not hand-writing new fixtures.
- `runScenarioRepeated` (runner.ts) + `passAtK` (judge.ts) + trial-group
  support (store.ts: `trial_group`/`trial_index` columns,
  `previousTrialGroup`, `trialGroupResults`) — τ-bench's pass^k
  reliability metric, systematizing the ad-hoc 3x manual check from the
  first pass. `cli.ts` now runs k=3 trials per scenario/transport by
  default (`CAIRN_EVALS_K=1` for fast dev iteration) and reports pass^k,
  not a single pass/fail.
- `judgeScenario` refactored to accept an injectable `clientFactory`
  (matching `GroqVerbLLM`'s existing DI pattern in `packages/sdk`) —
  found live that this repo has no real `ANTHROPIC_API_KEY` configured
  anywhere (demo-app's own `.env` has an empty placeholder; it runs on
  Groq), so judge logic needed to become testable without live network
  access, not just easier to test.

**Tests:** 36 real tests across 7 new/updated test files in
`packages/evals` (taxonomy, primitives, templates, store, judge,
scenarios/index, runner), full monorepo suite 284/284 passing, all
packages typecheck clean.

**Live-verified:**
- The primitive/genre refactor: the `create-new-invoice` scenario still
  passes unchanged after resolving its path/verify through the registry
  instead of a hardcoded string.
- Template expansion: ran `workflow-email-on-form-submit-2` (the
  `alerts@example.com` variant, never hand-written) against a real
  demo-app — real distinct goal text, real distinct verify check, real
  trace captured (correctly `achieved: false` — the same known
  incomplete-config behavior already documented, not a harness bug).
- `runScenarioRepeated`: ran `archive-named-invoice` 3x live — 1/3
  trials achieved, real evidence of the exact non-determinism pass^k
  exists to catch (this scenario has shown both ~1/3 and ~2/3 real
  success rates across separate live runs this session).

**Pending / not yet started:**
- Step 5 (the dashboard app) — next.
- Step 6 (new primitives: kanban, wizard, auth-gate, modal; new genres:
  marketplace, kanban-tracker) — not started.
- Step 7 (simulated-user mode, policy-constraint scoring) — not
  started, deliberately last per the build order.
- `judgeScenario` has never actually been called against a real Claude
  API in this environment — only the mocked-client test exists. The
  eval CLI's pass^k reporting is therefore unverified end-to-end (the
  trial-running half is proven live; the judging half is proven only by
  logic, not a real call) until a real `ANTHROPIC_API_KEY` is available.
- Retrofitted taxonomy tags reveal (honestly, by design —
  `taxonomy.test.ts` asserts this explicitly) 6 of 11 capability
  dimensions have zero scenario coverage today: `unachievable`,
  `policy-constraint`, `ambiguous-clarify`, `non-semantic-ui`,
  `navigation`, `error-recovery`. Real, tracked gaps, not forgotten
  ones — the dashboard's capability breakdown (step 5) will show this
  as empty bars once it exists, and steps 6-7 are what fill them in.

**Known gaps / did not fully solve:**
- `runScenarioRepeated` runs trials strictly sequentially, on purpose
  (avoids piling more load onto an already rate-limited Groq account,
  keeps each trial's timing independent) — this means a full k=3 suite
  run takes roughly 3x as long as a single pass, not yet offset by any
  parallelism. Acceptable for now; worth revisiting if the suite grows
  large enough for this to matter.
- No CI/pre-publish wiring, same gap as the first pass — still a manual
  step.

### Step 5: the dashboard app

The plan's literal instruction was `packages/evals/app/`. Deviated from
that on purpose: Next.js expects to own its package root's
`tsconfig.json`, which would collide with `packages/evals`'s existing
one (used by the CLI and vitest) the same way `examples/demo-app` is
already kept separate from the library packages in this repo. Built a
new sibling workspace package, `packages/evals-dashboard`, instead —
same convention, not a new one.

**Built:**
- `packages/evals-dashboard` — a small Next.js 14 App Router app, plain
  CSS (no Tailwind — avoids re-triggering the `lightningcss-darwin-
  arm64` native-binary issue already hit earlier this session).
- `lib/data.ts` — reads `@cairnvibe/evals`'s real SQLite store directly
  (`openStore`/`allRuns`/`trialGroupResults`, same functions the CLI
  uses) via new export-map entries (`./scenarios`, `./trace` added
  alongside the existing `./store`/`./taxonomy`/`./judge`/`./primitives`
  in `packages/evals/package.json`) — no separate API layer, since both
  packages already share one filesystem. Resolves the db path relative
  to the sibling `packages/evals` checkout by convention, overridable
  via `CAIRN_EVALS_DB_PATH`. Groups raw rows into per-(scenario,
  transport) summaries with real pass^k history, and a per-capability
  pass-rate aggregate — the same grouping logic both the scenario list
  and the capability breakdown read, computed once.
- **Scenario list** (`app/page.tsx`) — every scenario × transport pair,
  latest pass^k pill, capability tags, a real sparkline of every past
  trial group's pass/fail.
- **Trace viewer** (`app/runs/[trialGroup]/page.tsx`) — every trial in a
  group as an expandable card: verdict dimensions, judge reasoning, and
  every real copilot round trip / voice frame as its own drill-down
  `<details>`, down to the raw request/response JSON — native HTML
  disclosure widgets, no client-side JS needed for a v1.
- **Capability breakdown** (`app/capabilities/page.tsx`) — pass rate per
  taxonomy dimension, counting each scenario's latest trial group once;
  an empty dimension renders as "no coverage yet" rather than 0%, so the
  6 untagged gaps from step 1 read as gaps, not failures.
- `.claude/launch.json` gained an `evals-dashboard` entry (port 3210, so
  it can run alongside `demo-app` on 3000).

**Tests:** no new automated tests this step (a rendering-focused Next.js
app; `tsc --noEmit` is the real check here) — `packages/evals-dashboard`
typechecks clean, and `packages/evals`'s own typecheck + full 284-test
monorepo suite still pass after the new export-map entries.

**Live-verified:** the real blocker — no `ANTHROPIC_API_KEY` or
`DEEPGRAM_API_KEY` configured anywhere in this repo (same gap already
tracked above), so there was no real trial history sitting in
`packages/evals/data/evals.db` to load the dashboard against, and no way
to generate one live in this environment. Built `scripts/seed-demo-data.ts`
to seed the store through the **real** `openStore`/`recordRun` functions
(not placeholder JSON, not a mocked data layer) with realistic-shaped
`ScenarioRunResult`/`Verdict` rows matching this session's own documented
history (the real archive-named-invoice flakiness, the real voice
regression and its fix) — clearly labeled as seeded/demo data, not
production runs. Ran the dashboard against that seeded store in a real
browser: scenario list renders correct pass/fail pills, capability tags,
and a real two-color sparkline; the trace viewer renders all 3 trials of
a group with correct verdict scores and expandable round-trip JSON; the
capability breakdown renders correct per-tag ratios and "no coverage
yet" for the 6 untagged dimensions. No console errors, no server errors.

**Pending / not yet started (at the time of the entry above):**
- Step 5's remaining two views (comparison, run trigger) — scenario list
  + trace viewer were built first as the two highest-value views per the
  plan; not started yet.
- The dashboard has never been run against a REAL (non-seeded) trial
  history — still blocked on the same missing `ANTHROPIC_API_KEY`/
  `DEEPGRAM_API_KEY` gap. Once real keys exist, delete
  `packages/evals/data/evals.db` and run `npm run evals` for real; the
  dashboard code itself needs no changes to pick that up, since it reads
  the exact same store the seed script wrote to.
- Step 6 (new primitives/genres) and step 7 (simulated-user mode,
  policy-constraint scoring) — not started, per the build order.

**Update — step 5's last two views, closing it out:**

**Built:**
- `getCommits`/`getComparisonRows` (`lib/data.ts`) — every distinct
  commit with recorded runs, and a side-by-side stat diff (pass^k +
  averaged verdict dimensions) between any two of them for every
  scenario×transport pair either commit touched.
- **Comparison view** (`app/compare/page.tsx`) — a plain `<form
  method="GET">` commit-picker (no client JS) rendering a diff table;
  each row's `status` (`regressed`/`improved`/`unchanged`/`new-in-b`/
  `missing-in-b`) is computed from a real rule — a pass^k flip, or a
  ≥0.15 taskSuccess swing — not eyeballed from the raw numbers, per the
  plan's "regression detection highlighted" requirement.
- **Run trigger** (`lib/run.ts`, `app/run/`, `app/run/[id]/`) — a
  `"use server"` action spawns the real `npm run evals` CLI as a child
  process (cwd `packages/evals`), captures stdout/stderr to a log file,
  and redirects to a live log page. Deliberately runs the actual CLI
  command rather than reimplementing suite-running logic in the
  dashboard — its failure modes are the CLI's own, not something new to
  keep in sync.

**Tests:** no new automated tests (same reasoning as the first half of
this step — a rendering/process-spawning surface, `tsc --noEmit` is the
real check); `packages/evals-dashboard` typechecks clean, full monorepo
typecheck + 284-test suite still pass.

**Live-verified**, all in a real browser against the seeded demo store:
- Comparison view: `e9f8a7c` vs `a1b2c3d` correctly shows
  `workflow-email-on-form-submit-1` as **regressed** (pass→fail,
  taskSuccess −0.63) and two scenarios only present at `e9f8a7c` as
  `missing in B`; the default (two most-recent commits) correctly shows
  the real voice-regression fix as **improved** (fail→pass).
- Run trigger: clicking "Run suite now" really spawned `npm run evals`,
  the log page showed live output, and after it exited the page showed
  `exited 1` with the CLI's own real error —
  `cairn-evals: DEEPGRAM_API_KEY is not set — export it and re-run.` —
  proving the whole spawn → capture → redirect → status pipeline works
  end to end, using the real CLI's real failure, not a simulated one.
- No console errors, no server errors, across both views.

**Pending / not yet started:**
- The dashboard still has never been run against a REAL (non-seeded,
  fully-passing) trial history — the run-trigger live-check above
  actually *proves* why: this repo has no real `ANTHROPIC_API_KEY` or
  `DEEPGRAM_API_KEY` anywhere, so even triggering a run from the UI
  fails at the same `requireEnv` gate the CLI always has. Once real keys
  exist, delete `packages/evals/data/evals.db` and either run `npm run
  evals` directly or use the new in-UI trigger — both paths are now
  live-proven to work.
- Step 5 is now complete (all 4 planned views: scenario list, trace
  viewer, capability breakdown, comparison + run trigger). Step 6 (new
  primitives/genres) and step 7 (simulated-user mode, policy-constraint
  scoring) — not started, per the build order.

### Step 6a: kanban + modal primitives, the kanban-tracker genre

Step 6 calls for 4 new primitives and 2 new genres. Split it into two
sub-stages to keep each one a coherent, fully-verified commit — this
entry covers the smaller half: `kanban`/`modal` and the kanban-tracker
genre. `search-filter`/`wizard`/`auth-gate` and the marketplace genre
are next.

**Built:**
- `examples/demo-app` gained a real kanban board (`/board`) — the same
  real-SQLite-CRUD convention as `invoices.ts`/`workflows.ts`:
  `lib/board.ts` (server-only), `lib/board-types.ts` (client-safe split,
  same reasoning as `workflow-types.ts` — a "use client" component that
  imports the server file directly bundles `better-sqlite3` and fails to
  compile), `board_columns`/`board_cards` tables in `lib/db.ts`.
- API routes: `GET /api/board` (observe), `POST /api/board/reset`,
  `POST /api/board/cards` (create), `PATCH /api/board/cards/[id]`
  (edit), `POST /api/board/cards/[id]/move` (the kanban primitive's
  defining transition).
- `components/BoardColumns.tsx` — real columns/cards; a card moves via
  a `<select onChange>` (not a drag gesture) for the same reason the
  workflow canvas favors explicit connect actions: a real, directly-
  targetable state transition, not a pointer-drag an agent would have
  to simulate.
- `components/CardModal.tsx` — the modal primitive's real UI: a
  dynamically-opened dialog (not an inline edit) for a card's
  title/description, `data-ai`-tagged like every other interactive
  element in this app (so it's honestly NOT also claimed as
  `non-semantic-ui` coverage — that tag stays genuinely uncovered, see
  below).
- `packages/evals/src/primitives/index.ts` — `kanban` (`content-ops`,
  `multi-step-composite`) and `modal` (`content-ops`) primitives, both
  pointing at `/api/board`; the `kanban-tracker` genre (modeled after
  Trello/Linear) composing them.
- Two new real scenarios in `scenarios/index.ts`:
  `move-kanban-card-to-done` and `add-kanban-card-description` (the
  latter specifically exercises the modal, since the description field
  only exists inside it) — suite grew from 7 to 9.

**Tests:** `packages/evals`'s existing generic primitive/genre tests
(id-key consistency, capability-tag validity, genre-primitive
references) cover the two new entries with no changes needed — updated
`scenarios/index.test.ts`'s hardcoded suite-size assertion (7 → 9). No
new demo-app tests (it has none — the same rendering-surface reasoning
as `packages/evals-dashboard`). Full monorepo typecheck + 284-test suite
still pass.

**Live-verified**, in a real browser against a real running demo-app:
- Moved "Fix login bug" from In Progress to Done via the real `<select>`
  — confirmed both in the rendered page and via a direct
  `GET /api/board` call showing `columnId: "done"`.
- Opened "Design homepage"'s edit modal, typed a description, saved —
  confirmed the description persisted and rendered on the card, and via
  `GET /api/board`, exactly matching what `add-kanban-card-description`'s
  `verify.expectContains` checks for.
- Reset the board back to seed state afterward via
  `POST /api/board/reset` so the live demo-app is left clean.
- Found and fixed a real, pre-existing environment blocker along the
  way: the `lightningcss-darwin-arm64` native binary was missing from
  `node_modules` (an npm optional-dependency resolution gap on this
  machine, not something this session's own changes caused — it broke
  `/invoices` too, a page untouched by this stage), which made
  `examples/demo-app`'s entire Tailwind pipeline 500 on every route.
  Installed it locally (`npm install lightningcss-darwin-arm64@1.32.0
  --no-save`) to unblock this verification pass — deliberately
  `--no-save`, since a platform-specific optional dependency doesn't
  belong hand-pinned in `package.json` (it would break installs on
  other platforms); this is a session-local workaround, not a repo fix,
  and the same root cause is why `packages/evals-dashboard` avoided
  Tailwind entirely when it was built.

**Pending / not yet started:**
- `search-filter`, `wizard`, `auth-gate` primitives and the marketplace
  genre — step 6's other half.
- Step 7 (simulated-user mode, policy-constraint scoring) — not
  started, deliberately last per the build order.
- The `lightningcss-darwin-arm64` gap is unresolved at the repo level —
  a fresh `npm install` on this machine (or any machine with the same
  gap) will very likely lose the local workaround again, since it was
  never recorded in the lockfile. Worth a real root-cause look
  (why did `npm install` skip an optional dependency it should have
  resolved) if it keeps recurring, but out of scope for this stage.

### Step 6b: search-filter + wizard + auth-gate primitives, the marketplace genre

Closes out step 6 — the second, larger half: 3 more primitives and the
marketplace genre, modeled after Amazon (search, cart, checkout).

**Built:**
- `examples/demo-app` gained a real shop (`/shop`, `/shop/checkout`) —
  same real-SQLite-CRUD convention as `board.ts`: `lib/shop.ts` (server-
  only), `lib/shop-types.ts` (client-safe split), 4 new tables in
  `lib/db.ts` (`shop_products`, `shop_cart`, `shop_session`,
  `shop_orders`). `shop_session` is a real single-row logged-in flag —
  matching this demo app's existing convention of no real multi-user
  auth (the point is exercising a real gated flow, not building an
  identity system).
- API routes: `GET /api/shop/products` (real `?q=`/`?category=` query —
  the search-filter primitive's observePath), `POST /api/shop/reset`,
  `GET`/`POST /api/shop/cart`, `GET /api/shop/auth` +
  `POST .../login|logout`, `POST /api/shop/checkout` (**a real 403** when
  the session isn't logged in, real 400 when the cart is empty — not a
  UI-only appearance of a gate), `GET /api/shop/orders`.
- `components/ShopSearch.tsx` — the search-filter primitive's real UI:
  drives the URL's own search params (`router.push`), so the SERVER
  component re-renders with real filtered results — no client-side
  fetch, no state to keep in sync with the server.
- `components/CheckoutWizard.tsx` — the wizard primitive's real UI: a
  real 3-step flow (review → shipping → confirm), each step's Next
  gated on that step's own real validation, ending in a real
  order-creating POST.
- `app/shop/checkout/page.tsx` + `components/ShopAuthControls.tsx` — the
  auth-gate primitive's real UI: not logged in renders a real blocking
  message + login button instead of the wizard; the block is real
  because the checkout API itself enforces it server-side (see the 403
  above), not just hidden client-side.
- `packages/evals/src/primitives/index.ts` — `search-filter`
  (`info-seeking`), `wizard` (`multi-step-composite`, `content-ops`),
  `auth-gate` (`policy-constraint` — the first scenario to honestly
  close this previously-zero-coverage taxonomy gap) primitives; the
  `marketplace` genre composing them.
- **Real, documented architectural deviation**: the plan's own sketch
  composed marketplace as `search-filter + table-crud + wizard +
  auth-gate`. Dropped `table-crud` from the composition — this
  registry's `PRIMITIVES` binds each primitive id to ONE concrete
  `resetPath`/`observePath`, and `table-crud` already means
  `/api/invoices`; reusing that literal id for the shop's own catalog
  would silently reset/observe the wrong app's data when a marketplace
  scenario runs. Documented inline in `primitives/index.ts` as a real,
  named architectural gap (per-genre primitive parameterization) worth
  a real fix if a third genre ever needs it — not invented here just to
  satisfy the plan's literal wording.
- Two new real scenarios: `search-shop-for-cheapest-home-item`
  (info-seeking) and `complete-shop-checkout` (multi-step-composite,
  content-ops, **policy-constraint**) — suite grew from 9 to 11.
  `taxonomy.test.ts`'s tracked-uncovered-gap assertion updated: 6
  dimensions uncovered → 5 (`policy-constraint` closed).

**Tests:** existing generic primitive/genre tests cover the 3 new
primitives/1 new genre with no changes needed; updated
`scenarios/index.test.ts`'s suite-size assertion (9 → 11) and
`taxonomy.test.ts`'s uncovered-tags assertion. Full monorepo typecheck +
284-test suite still pass.

**Live-verified**, in a real browser against a real running demo-app,
the full intended flow end to end:
1. Filtered the catalog to the Home category via the real `<select>` —
   confirmed the server re-rendered with exactly the 2 real Home items
   (Desk Lamp, Throw Blanket), matching what
   `search-shop-for-cheapest-home-item` expects.
2. Added Desk Lamp to cart, then navigated to `/shop/checkout` while
   still logged out — confirmed the real auth-gate rendered ("You need
   to log in before checking out"), not the wizard.
3. Logged in, confirmed the wizard now rendered at step 1 with the real
   cart contents.
4. Walked all 3 wizard steps (review → filled real email/address →
   confirm) and placed the order — confirmed a real order id came back,
   and `GET /api/shop/orders` showed the real order containing
   `"name":"Desk Lamp"`, exactly what `complete-shop-checkout`'s
   `verify.expectContains` checks.
5. Isolated a cart-quantity discrepancy noticed mid-test (a wizard step
   showed "× 2" for a single add-to-cart click) down to the browser
   automation tool's own click-coordinate flakiness in this session
   (observed independently misfiring on stale `ref` coordinates several
   times this stage) — confirmed by issuing one direct `fetch()` POST to
   `/api/shop/cart` and getting `quantity: 1` back, proving `addToCart`
   itself is correct. Real finding, real verification of where the fault
   actually was, not assumed away.
6. Confirmed zero console/server errors on `/shop` and `/shop/checkout`
   in a fresh tab, then reset shop state via `/api/shop/reset` so the
   live demo-app is left clean.

**Pending / not yet started:**
- Per-genre primitive parameterization (the real gap the `table-crud`
  deviation above surfaces) — worth fixing if a third genre wants its
  own CRUD-table-shaped data; not blocking today.
- Step 6 is now fully complete (all 4 new primitives, both new genres).
  Step 7 (simulated-user mode, policy-constraint scoring) is next and
  last in the Phase 1 redesign build order — the taxonomy now has real
  `policy-constraint` coverage to build that scoring against, instead of
  starting from zero.
- The `lightningcss-darwin-arm64` gap from step 6a is still unresolved
  at the repo level (unchanged from that entry).

### Step 7: policy-constraint scoring + simulated-user mode

The last and, per the plan, deliberately riskiest step — built last on
purpose, on top of a proven taxonomy/primitive/UI foundation instead of
guessed at first. Both pieces got real, live, multi-round testing against
the actual running demo-app and Cairn's real Groq-backed agent, which
surfaced and fixed two genuine bugs before this could be called done.

**Built:**
- **Policy-constraint scoring** — `Scenario.policyConstraint` (a stated
  business rule, `scenario.ts`) and `Verdict.policyCompliance`
  (`judge.ts`, its own 0-1 dimension, `null` when a scenario declares no
  constraint — never a free passing score). `pass` now additionally
  requires `policyCompliance is null OR policyCompliance >= 0.8`. The
  judge's user message now includes the real `policyConstraint` text and
  (when present) the real conversation transcript, so it can check
  compliance across the WHOLE trace, not just final state.
- **Simulated-user mode** (`simulated-user.ts`, new) — τ-bench's mode: a
  separate model plays a real persona (`SimulatedUserConfig.opening` +
  `privateContext`) and reacts to Cairn's real replies turn by turn,
  ending the conversation via a real forced `end_conversation` tool call
  (same forced-tool-call-for-a-terminal-signal pattern as judge.ts's own
  verdict, not free-text parsing). Injectable `clientFactory`, same DI
  reasoning as `judgeScenario`/`GroqVerbLLM` — no real `ANTHROPIC_API_KEY`
  exists anywhere in this repo.
- `runner.ts` gained `runSimulatedUserConversation` — drives the real
  typed widget through a real multi-turn back-and-forth (typed transport
  only; voice is a real, larger piece of separate work, scoped out
  deliberately with an explicit thrown error rather than half-built).
  Reuses the existing `waitUntilQuiet` rather than re-deriving similar
  wait logic, and shares ONE deadline across the whole conversation
  rather than re-granting a fresh `timeoutMs` every turn.
- `trace.ts` gained `ConversationTurn`/`ScenarioRunResult.conversation` —
  a clean turn-by-turn transcript alongside the raw round trips, for both
  the judge and (later) the dashboard's trace viewer.
- Two scenarios updated/added: `complete-shop-checkout` (step 6b) now
  carries a real `policyConstraint` (it only had the capability tag
  before this step added the actual judged field — found live while
  wiring this up, and fixed retroactively rather than left cosmetic).
  New: `archive-invoices-with-approval-threshold` — a real simulated-user
  + policy-constraint scenario, closing the `ambiguous-clarify` taxonomy
  gap alongside `policy-constraint`.

**Tests:** 9 new tests (`simulated-user.test.ts`: role inversion, reply
vs. end-signal handling, error on neither; `runner.test.ts`:
`extractAgentText` covering the plain-text case, the `tour` per-step
join, and malformed input) plus updates to existing tests for the new
`policyCompliance` field and taxonomy/suite-size counts. Full monorepo
typecheck + 293-test suite passing.

**Live-verified**, in real multi-round testing against demo-app and
Cairn's real Groq-backed agent (no mocked LLM anywhere in the loop except
the simulated-user's OWN model call, scripted via the same DI hook —
proving the harness mechanics, not the persona-quality half, which
`simulated-user.test.ts` covers instead):

- **Real bug #1, found and fixed live**: the first attempt at a second
  turn hung for the full Playwright action timeout. Diagnosed with a
  disposable diagnostic script (polling the input's `disabled`/`visible`
  state directly) before touching any code — ruled out a first guess (a
  `tour` verb's spoken narration disabling the input) by testing it, then
  found the real cause: several of this playground app's own action
  handlers (`CopilotWithActions`, `ArchiveInvoiceButton`, etc.) call
  `window.location.reload()` after a real write completes, which
  destroys the widget's DOM/state mid-conversation whenever the agent
  acts before the conversation is otherwise done. Fixed by treating that
  failure as the conversation ending naturally (the transcript captured
  so far is itself real signal — e.g. "archived without asking" — not
  something to discard by crashing the run) instead of a fatal error.
- **Real bug #2, found and fixed live**: `archive-invoices-with-approval-
  threshold`'s original `verify.expectContains` (`"Acme Co."` and
  `"Archived"` as two separate substrings) was satisfiable by TWO
  DIFFERENT invoices — a run that archived only the cheap one already
  matched, falsely reporting `achieved: true`. Fixed by combining the
  three adjacent fields (`client`, `amount`, `status`) into one substring
  that pins them to the same real object; verified against both a
  correctly-partial-archive state (now correctly `false`) and a
  fully-correct state (`true`).
- **Real design bug, found and fixed live**: the scenario's first version
  told the agent nothing about the $1000 threshold anywhere it could see
  it (only `privateContext`, which only the simulated-user model reads) —
  an unwinnable test by construction. Fixed by moving the real
  instruction into `simulatedUser.opening` itself, the way an actual user
  would state it.
- **Real agent behavior observed** (not a harness bug, a genuine finding
  about Cairn's current capability): across 3 live runs, the real agent
  correctly identified which invoice was over $1000, and in two of three
  runs asked before touching it — proactively, from an explicit user
  instruction, with no special prompting added for this scenario. The
  third run and later turns repeatedly hit
  `code: "tool_use_failed", message: "attempted to call tool 'json'..."`
  and `rate_limit_exceeded` (Groq's daily token quota was nearly
  exhausted by this session's own live testing) — real, already-tracked
  Groq flakiness (see the "Foundation" entry above), not a new
  regression; the harness surfaced it faithfully in the transcript
  instead of crashing or masking it.
- Confirmed the full mechanism end to end: multi-turn send → capture →
  extract → decide-next-turn → graceful-terminate, with zero `runError`s
  across all 3 live runs despite hitting two different real failure
  modes (a page reload mid-conversation, and repeated Groq errors).

**Pending / not yet started:**
- Voice + simulated-user combination — explicitly out of scope, real
  separate work (synthesizing each reply to speech, re-arming the fake
  mic mid-conversation).
- A live run of `judgeScenario` itself against a real Claude API scoring
  a real simulated-user transcript — still blocked on the same missing
  `ANTHROPIC_API_KEY` gap tracked since the first eval-harness pass;
  `judge.test.ts`'s mocked-client test is what stands in for it.
- 4 capability dimensions remain genuinely uncovered by any scenario:
  `unachievable`, `navigation`, `non-semantic-ui`, `error-recovery` — a
  real, tracked, honest gap (down from 6 at step 1), not filled by this
  step since it wasn't step 7's scope.
- The Phase 1 redesign's 7-step build order is now complete. Per the
  plan, Phases 2-5 (voice architecture upgrade, the Planner/Executor/
  Critic/Talker multi-agent redesign, deep runtime context, memory) each
  get their own focused plan-and-approval pass when picked up.

## Phase 3 — the multi-agent redesign (Planner/Executor/Critic/Talker)

Reordered ahead of Phase 2 per explicit direction — the architecture
change that actually makes the agent smarter (plan across a platform,
stop fooling itself about completion) rather than the voice-latency
work. Scoped with real external research (Agent S2, CODA, Skyvern 2.0's
real production numbers, Magentic-One's dual-ledger pattern, "Are We
Done Yet?", the scheduler-theoretic agent-loop framework, PIVOT,
"Revisable by Design") plus a full reading of the actual current
implementation — see the plan file's "Phase 3" section for the full
design and 5-step build order. Working through that build order one
step at a time, each independently shippable and verified.

### Step 1: loop dedup — driveAgentLoop, zero behavior change

The real problem this whole phase exists to fix (documented in this
file's batch-verb commit notes): a batch of 2 clicks succeeded, and the
model kept looping 4 more iterations before giving up, never recognizing
its own success — because "are we done" today is purely "did the model
pick a TERMINAL_VERBS verb," never a check against real state. Fixing
that needs a real Critic; but the loop that Critic has to attach to was
independently re-implemented TWICE (`index.tsx`'s `runTypedAgentLoop` for
the HTTP/typed path, `realtime-server.ts`'s `finalizeTurn` for the
WebSocket/voice relay) — a real, live duplication risk any later step
would have had to fix twice, by hand, forever. This step retires that
risk first, before any Planner/Critic code exists, with deliberately
zero behavior change — nothing here is allowed to change what either
transport actually does, only where the shared shape lives.

**Built:**
- `packages/sdk/src/agent-loop.ts` (new) — `driveAgentLoop`, the shared
  skeleton: ask via `getNextStep`, check `TERMINAL_VERBS`, execute a
  continuing step via `executeStep`, fold the observation into working
  history, ask again, up to `maxIterations` (default 6, unchanged).
  Deliberately does NOT own transport-specific side effects (sending a
  client message, TTS, barge-in cancellation, committing to real
  cross-turn memory) — those stay in each transport's own closures,
  wired through `onStep`/`onStepResult` hooks that can abort the loop
  (covers `finalizeTurn`'s two real generation/barge-in checkpoints) and
  in what each caller does with the returned outcome
  (`terminal`/`unparseable`/`gave-up`/`aborted`). Also carries the
  `summarizeVerbForHistory`/`MAX_HISTORY_TURNS` helpers, which were
  themselves independently duplicated in both loop drivers (byte-for-byte
  identical) — moved here once, used by both.
- `realtime-server.ts`'s `finalizeTurn` and `index.tsx`'s
  `runTypedAgentLoop` both rewired to call `driveAgentLoop` — each kept
  100% of its own real side-effecting code (the Talker ack sequencing,
  the Deepgram single-utterance Speak-connection constraint, the raw/
  untyped HTTP-response handling the stateless typed path genuinely needs
  that realtime's always-valid in-process `resolveVerb` call doesn't),
  just moved into hook closures instead of an inline `for` loop.
- Found and fixed a real, additional duplication while doing this:
  `summarizeVerbForHistory`/`MAX_HISTORY_TURNS`/`MAX_LOOP_ITERATIONS`
  were actually triplicated, not just duplicated — a third, independent
  copy lives in `web-component.ts` (the vanilla-JS widget), whose own
  `summarizeVerbForHistory` is missing 5 of the 9 verb cases (it has no
  multi-step loop at all today, single-shot only). Deliberately left
  untouched — out of this step's scope (only the two loop-*driving*
  transports), but noted here as a real, tracked gap: `web-component.ts`
  would currently mishandle a continuing verb if the server ever sent it
  one, and its history summaries silently degrade to "(no response)" for
  click/fill/read/call_tool/batch.

**Tests:** `agent-loop.test.ts` (new, 15 tests) covering the driver in
isolation — terminal-on-first-call, continuing-then-terminal with real
history folding, "no result" fallback, unparseable, gave-up at the
iteration cap, both abort checkpoints (`onStep`/`onStepResult`), the
terminal/continuing flag passed to `onStep`, `MAX_HISTORY_TURNS` capping,
and real seed-history preservation. Critically: `realtime-server.test.ts`'s
existing 9 tests — including the exact-twice-ack invariant, the barge-in/
generation-drop test, batch-as-continuing-verb, and the iteration-cap
gave-up path — all pass **completely unmodified**, which is the real
proof this refactor didn't change `finalizeTurn`'s behavior. Full
monorepo typecheck + 306-test suite passing.

**Live-verified**: rebuilt `packages/sdk` (`npm run build`, so
`dist/realtime-server.js` reflects the change) and ran a real multi-step
"archive the overdue invoice" request through the refactored
`runTypedAgentLoop` against a live demo-app and Cairn's real Groq-backed
agent — two real `/api/copilot` round trips (a `click` then a terminal
`explain`, the exact continuing-then-terminal shape this step's logic
depends on), and Globex Inc. really ended up `Archived`. Confirmed zero
console errors in a fresh tab afterward.

**Pending / not yet started:**
- The realtime/voice transport's refactored `finalizeTurn` was NOT
  live-verified this step (only unit-tested) — this session's own Groq
  daily token quota was already near-exhausted from step 7's testing
  (real `rate_limit_exceeded` errors observed, ~28min retry windows).
  The unit-test coverage here is unusually strong for this exact
  function (9 precise, scenario-specific tests, all passing unmodified),
  which is why this was judged an acceptable gap for this step rather
  than blocking on it — worth a real live voice check once quota
  recovers, before Step 3 (the Critic) lands on top of this.
- Steps 2-5 of Phase 3's build order (Plan/Progress types + lazy-gated
  Planner; the Critic — the actual bug fix; Executor local retry; the
  Talker event stream) — not started.
- `web-component.ts`'s own duplication/gap (found above) — not fixed,
  deliberately out of this step's scope.

### Step 2: Plan/Progress types + a lazy-gated Planner, Critic absent

**Built:**
- `packages/core/src/plan.ts` (new, re-exported from `index.ts`) —
  `Task`/`Plan`/`ProgressLedger` schemas (a flat ordered list, not a DAG;
  versioned so a real revision is always a new version, never an
  in-place mutation) plus `PlannerOutput`/`PlannerOutputTask` — a
  deliberately NARROWER schema for what the model itself produces
  (`version` and each task's `status` are harness-owned bookkeeping the
  model has no way to correctly reason about, assembled around its raw
  output instead of asked of it directly). Kept free of any import from
  `index.ts` (a real circular-dependency risk given `index.ts` re-exports
  this file) — confirmed live: `plan.test.ts`'s first test is specifically
  a smoke test that importing via `index.ts` doesn't throw a TDZ error.
- `packages/sdk/src/server.ts` — generalized `AnthropicVerbLLM`/
  `GroqVerbLLM` to accept an optional `toolName`/`toolDescription` pair
  (defaulting to the existing verb-resolution tool, so every existing
  caller/test is unaffected) instead of hardcoding `VERB_TOOL_NAME` —
  the same real rotation/retry/model-selection machinery now serves any
  forced-tool-call shape, not just verb resolution. `createToolLLM`
  factors out `createVerbLLM`'s own logic; `createPlanLLM` is the new
  thin wrapper for the Planner's tool. `resolvePlan(llm, goal, version)`
  mirrors `resolveVerb`'s own resilience discipline exactly — never
  throws to the caller, degrades to a real single-task fallback plan
  ("do the whole goal as one task") on any failure, so a Planner hiccup
  can't block a turn.
- `realtime-server.ts`'s `finalizeTurn` — a real Planner call wired into
  the SAME lazy gate the existing Talker ack already uses (`!terminal &&
  iteration === 0`), fire-and-forget, logged, never awaited — a real Plan
  gets produced but nothing acts on it yet (no Critic until step 3).
  `ConnectionDeps.planLLM` is optional specifically so this is additive:
  every existing caller/test that doesn't pass it gets exactly today's
  behavior, no Planner call at all.
- **Real scoping finding, not an oversight**: only the realtime/voice
  transport is wired this step. The typed/HTTP transport's `resolveVerb`
  is called fresh per stateless POST with no iteration context of its
  own — actually exposing a Plan there needs the `{verb, plan?,
  progress?}` wire-contract change the plan file's own risk section
  already named, which has real backward-compatibility implications for
  published `@cairnvibe/core`/`@cairnvibe/sdk` consumers. Deferred
  deliberately to step 3, when the Critic actually needs the Plan to be
  client-actionable on both transports — not invented speculatively now
  for a piece nothing yet uses.

**Tests:** `plan.test.ts` (7, new) — schema validation plus the
circular-import smoke test. `server.test.ts` gained 9 tests: custom
`toolName`/`toolDescription` on both providers (including a real check
that a tool_use block under the OLD default name is correctly ignored
once the tool name has changed), and 5 for `resolvePlan` itself (real
request shape, real Plan assembly with correct `status`/`version`
bookkeeping, a custom version number, and both fallback paths — LLM
throw, schema-invalid response). `realtime-server.test.ts` gained 2:
the Planner call fires exactly once on the first continuing step and is
provably non-blocking (a deliberately slow fake Planner client, awaited
separately from the turn itself, confirms the turn's real outcome —
`speakStreamed`'s final call — is unaffected), and a turn with no
`planLLM` configured behaves exactly as before (opt-in, not required).
Full monorepo typecheck + 322-test suite passing — `packages/core` and
`packages/sdk` both rebuilt (`npm run build`) so Node-resolved `dist/`
output actually reflects the new exports (a real gotcha hit live:
`packages/core`'s `exports` map resolves `"."` to `dist/index.js` under
Node, not raw source — `plan.ts`'s new exports were invisible to vitest
until rebuilt).

**Live-verified:** wrote a small script calling the real, unmocked
`resolvePlan` against demo-app's real, live Groq credentials (independent
of the voice-transport wiring, which is in-process/fire-and-forget and
already covered by precise unit tests) — a real request for "Set up a
workflow that emails ops@example.com whenever someone fills out my
contact form" produced a real, coherent 3-task plan (navigate to
workflow settings → configure the trigger/action and save → submit a
test entry and verify the email arrives), each with a genuinely
checkable `doneContract`, from the actual production model this repo
runs on.

**Pending / not yet started:**
- The typed/HTTP transport's own Planner wiring — deliberately deferred
  (see the scoping finding above) until the wire-contract change is
  actually needed.
- Steps 3-5 of Phase 3's build order (the Critic — the actual fix for
  the diagnosed bug; Executor local retry; the Talker event stream) —
  not started.
- The realtime transport's Planner wiring was verified via `resolvePlan`
  directly against real Groq, not through an actual live voice call over
  the WebSocket relay (would need real audio via the fake-mic technique,
  plus the same Groq-quota constraint noted in step 1) — the unit tests
  proving the wiring's timing/opt-in behavior plus this direct real-model
  check were judged sufficient for an observability-only, no-user-visible-
  behavior-change step.

### Step 3: the Critic — the actual fix for the diagnosed bug

The step everything else in this phase exists in service of. Before this
step, "are we done" was purely "did the model pick a `TERMINAL_VERBS`
verb" — never checked against real state. After it, a genuinely separate
pass looks at the real observation from each continuing step and decides
whether the CURRENT task's own `doneContract` is actually satisfied,
independent of whatever the model itself claims or does next.

**Built:**
- `packages/core/src/plan.ts` — `CRITIC_VERDICTS`
  (`continue`/`task_complete`/`replan`/`give_up`) and `CriticVerdictSchema`
  (`verdict`, optional `expected`/`actual` — PIVOT's structured diff,
  only meaningful on `replan` — and required `reasoning`).
- `packages/sdk/src/server.ts` — `resolveCritic(llm, task, goal, verb,
  observation)`, structurally mirroring `packages/evals/src/judge.ts`'s
  `judgeScenario` on purpose (a separate model, forced tool call,
  structured verdict — the same real, already-proven-in-this-repo
  pattern, not a new one invented for this). Same resilience discipline
  as `resolveVerb`/`resolvePlan`: never throws, degrades to a real,
  harmless `continue` verdict on any failure. `createCriticLLM` is the
  same thin wrapper over `createToolLLM` as `createPlanLLM`.
- `packages/sdk/src/agent-loop.ts` — `driveAgentLoop` gained an optional
  `runCritic` hook and two new outcomes, `critic-complete`/
  `critic-give-up`. This is the actual mechanism of the fix: a
  `task_complete` (or `give_up`) verdict ends the loop **immediately**,
  even though the model's own verb was never a `TERMINAL_VERBS` member —
  no second `getNextStep`/model call "hoping it notices." A bare
  `continue`/`replan` verdict falls through and keeps the loop going
  exactly as if `runCritic` were absent — `driveAgentLoop` itself has no
  concept of a Plan at all, only "stop or keep going"; a caller's own
  `runCritic` closure is what actually replans (see below), keeping the
  shared driver domain-agnostic.
- `realtime-server.ts`'s `finalizeTurn` — step 2's fire-and-forget,
  logged-only Planner call is now a real, awaited dependency: a
  `plan`/`progress` pair tracked in the connection's own closure state,
  advanced by a real `runCritic` implementation. `task_complete` on a
  non-last task advances `currentTaskIndex` and keeps looping (a real,
  multi-task turn); on the last task, it propagates straight to
  `driveAgentLoop`, ending the turn there. `replan` calls `resolvePlan`
  again with a bumped `version` — a real new Planner call, never a
  silent patch to the existing plan. A harness-enforced stall budget
  (`STALL_THRESHOLD = 3`, Magentic-One-sized) escalates a
  `continue`-forever pattern to `give_up` on its own, rather than
  trusting the Critic alone to eventually notice it's stalling. A
  `critic-complete`/`critic-give-up` outcome is spoken using the
  verdict's own real `reasoning` — a genuinely more specific message
  than the old generic "I wasn't able to finish that."

**Tests:** `plan.test.ts` gained 4 (schema validation for both real
verdict shapes, plus rejecting an invented verdict and a missing
`reasoning`). `server.test.ts` gained 5 for `resolveCritic` (the real
request shape sent to the model, a real `replan` diff round-tripping
correctly, both fallback paths, and the custom-tool-name wiring).
`agent-loop.test.ts` gained 7 for `runCritic`, including the single most
load-bearing test in this whole step: **a `task_complete` verdict ends
the loop after exactly ONE `getNextStep` call** — the literal, direct,
unit-level proof the diagnosed bug is fixed at the driver level.
`realtime-server.test.ts` gained 3 real integration-level tests proving
the same fix through the ACTUAL `finalizeTurn` code path (not just the
driver in isolation): a `task_complete` verdict on a real 2-click batch
ends the turn with exactly one `respond()` call and the Critic's own
reasoning spoken; a `give_up` verdict ends the turn early with its own
specific message instead of the generic fallback; a multi-task plan
correctly advances instead of ending prematurely. All 11 of step 1-2's
existing tests still pass **completely unmodified**. Full monorepo
typecheck + 341-test suite passing.

**Live-verified:** a real, unmocked `resolvePlan` → `resolveCritic` call
sequence against demo-app's real Groq credentials, shaped exactly like
the diagnosed bug's own real scenario (DEVELOPMENT.md's batch-verb
commit notes: a batch of 2 clicks succeeding). Two real checks:
1. **Real success** — given a real observation matching the doneContract
   ("Both invoices archived: ... status now Archived"), the real Critic
   returned `task_complete` with correct, specific reasoning — the exact
   judgment that was missing before this step, that would have ended the
   diagnosed bug's real turn immediately instead of the model looping 4
   more times.
2. **Real failure** — given an observation that contradicts the
   doneContract ("status still Overdue"), the real Critic returned
   `replan` with a genuinely useful, real `expected`/`actual` diff — not
   just a pass/fail check, an example of it actually reasoning about
   *why* the approach failed.

**Pending / not yet started:**
- The typed/HTTP transport's Critic wiring — same deferred wire-contract
  dependency as step 2's Planner wiring.
- A real, full live voice call exercising this end to end over the
  WebSocket relay — verified instead via real integration-level unit
  tests (fake WebSocket, real assertions on `finalizeTurn`'s actual
  control flow) plus the direct real-Groq check above, for the same
  reasons (Groq quota, real-audio complexity) noted in steps 1-2.
- Steps 4-5 of Phase 3's build order (Executor local retry; the Talker
  event stream) — not started.
- The Critic currently judges from the step's own text observation only
  — not fresh `liveElements`/a real DOM snapshot. The observation is
  already real, grounded data (a real tool-execution result, not a
  self-report), so this is a reasonable v1 scope, but richer live-state
  grounding for the Critic is a real, named enhancement opportunity for
  later, not implemented here.

### Step 4: Executor local retry — bounded, LLM-free recovery

CODA's own point (research item #4 in the plan): the Executor should get
real local retry latitude for a genuinely MECHANICAL miss before a
failure escalates all the way to the Critic/a replan — never a second
LLM call, since that would blur the clean "who has an opinion" boundary
step 3 just established.

**Built:**
- `packages/sdk/src/element-ladder.ts` — `findElementWithRetry(target,
  liveElements, attempts=2, delayMs=300)`, a thin, bounded wrapper around
  the existing `findElement`: on a miss, waits once and tries again
  (never more than `attempts` times) before giving up for real. Past the
  `liveElements` map's own exact-match check, `findElement` already
  queries the LIVE DOM directly (`document.querySelector` on data-ai/
  aria-label/role/text) — a stale frozen snapshot doesn't matter to that
  half, which is what makes a plain re-try (not a fresh scan) a real fix
  for a re-render that swapped the DOM node the snapshot pointed at, or
  an animation/async render that hadn't settled yet on the first look.
- `packages/sdk/src/verb-executor.ts`'s `executeOneBatchAction` — the
  three DOM-touching batch actions (click/fill/read) now call
  `findElementWithRetry` instead of the bare, single-shot `findElement`.
  **Deliberately scoped to batch only**, matching the plan's own build
  order precisely — batch's later steps are the ones most likely to race
  a DOM update an earlier step in the SAME batch just triggered, which is
  exactly the case this recovers from. Single-step click/fill/read
  (`dispatchVerb`) stay untouched on purpose: they're currently
  synchronous, and converting them to the same async-retry shape would
  have broken every existing test that asserts `onToolStep` fired
  immediately, for a benefit (retry on a single, not-batched step) the
  plan never actually asked for — real scope discipline, not an
  oversight.

**Tests:** `element-ladder.test.ts` (new, 4 tests) covers the retry
helper in real isolation — the two the plan's own verification section
explicitly calls for (a real transient miss recovering once the element
becomes available during the wait; a genuinely broken target still
failing after all attempts, never masked as success), plus a
no-added-latency check for the common already-found case and a bounded-
attempts check. `verb-executor.test.ts` gained 1 real integration-level
test proving the SAME positive case through the actual batch dispatch
path (not just the helper in isolation): a 2-action batch where the
first target is missing at the start and appears mid-retry — the batch
recovers and continues to its second, unrelated step, instead of
stopping the whole batch on what was really just a timing miss. All 31
pre-existing `verb-executor.test.ts` tests still pass **completely
unmodified** (one, the deliberate-miss "stops at first failure" test,
now correctly takes ~300ms longer — the real, expected cost of one bounded
retry wait before a genuine miss gives up, not a regression). Full
monorepo typecheck + 346-test suite passing.

**Real bug found and fixed while writing this step's own first test**:
`BatchActionSchema` requires a minimum of 2 actions (`z.array(...).min(2)`)
— an early draft of the new positive-case test used a single-action
batch, which silently failed schema validation and degraded to the
generic `FALLBACK_TEXT` explain path instead of ever reaching the batch
dispatcher at all (no thrown error, no test failure signal beyond
`onToolStep` mysteriously never firing). Reproduced and isolated outside
vitest entirely (a standalone tsx script) before finding the real cause,
rather than guessing at the new retry code — fixed by rewriting the test
with a realistic 2-action batch, matching how a real multi-click batch
actually looks.

**Live-verified (partial):** rebuilt `packages/sdk` and attempted a real
"archive both invoices" request against a live demo-app and Cairn's real
Groq-backed agent (the exact real multi-step/batch shape this step
targets) — 2 real `/api/copilot` round trips completed before hitting
the SAME Groq daily-token-quota exhaustion already documented in steps
1-3 (`rate_limit_exceeded`, this time with a ~16-minute retry window) —
an environmental constraint, not a regression from this change (confirmed
via the real server error log). The retry mechanism's own correctness is
proven at the unit/integration level above; a full live re-verification
of the batch-recovery path specifically is worth doing once quota
recovers, but wasn't required to ship this step given the precision of
the existing test coverage.

**Pending / not yet started:**
- A full live re-verification of the batch retry path specifically,
  blocked on the same Groq quota constraint — not a correctness gap, a
  verification-depth gap honestly tracked.
- Step 5 of Phase 3's build order (the Talker event stream) — not
  started; this is also the LAST step in the currently-approved Phase 3
  plan.
- Single-step (non-batch) click/fill/read retry — deliberately out of
  scope (see the scoping note above), a real, named follow-up if this
  ever proves worth doing for the single-step case too.

### Step 5: the Talker event stream — the last step of Phase 3

The last step in the currently-approved Phase 3 build order. "Revisable
by Design"'s pattern (research item #4): an append-only, typed event
stream a narration layer consumes as a pure downstream projection, never
blocking or blocked by the agent loop that emits the events.

**Built:**
- `packages/core/src/index.ts` — `AgentEventSchema`
  (`act`/`obs`/`thk`/`inj`, discriminated on `type`). Defined here, not
  `plan.ts`, specifically because `act` needs the already-defined
  `VerbResponseSchema` — `plan.ts` deliberately avoids importing from
  `index.ts` at all (a real circular-dependency risk, since `index.ts`
  re-exports `plan.ts`), so this schema lives wherever it can actually
  use what it needs without introducing that cycle. `obs`'s `ok` field
  means "a real observation arrived" (vs. a timeout/no-result) — **not**
  "the underlying action succeeded"; documented explicitly so it's never
  misread as a success/failure flag (a real miss like "could not find
  that element" is still `ok: true` — the step genuinely completed and
  produced a real result, it just wasn't a successful one).
- `packages/sdk/src/agent-loop.ts` — `driveAgentLoop` gained an optional
  `onEvent` hook. The driver itself emits `act` (right after a step's own
  `onStep` abort check passes — never for a discarded/aborted verb) and
  `obs` (right after `onStepResult`'s own abort check passes — never for
  a discarded observation), since it already has that data at exactly
  those points. `thk`/`inj` stay caller-emitted: a caller's `onStep`/
  `runCritic` closures share the same plain `onEvent` callback reference
  (via a local `emitEvent` function captured in the same outer scope,
  not routed back through `deps` itself) to emit Critic reasoning or
  filler narration — `driveAgentLoop` has no opinion on those event
  kinds, it only carries them through.
- `realtime-server.ts`'s `finalizeTurn` — the existing ack mechanism
  genuinely migrated to be an event consumer: `onStep` now emits a real
  `{type: "inj", text: ACK_PHRASES[...]}` event instead of directly
  calling `speakStreamed(...)`; a small `emitEvent` function (this
  transport's own minimal Talker projection) is what actually turns an
  `inj` event into the real `speakStreamed()` call and sets `ackPromise`
  — same real sequencing/timing as before, just reached through a real
  event instead of an inline side effect buried inside `onStep`. The
  Critic's own `resolveCritic` call now also emits a real `thk` event
  carrying its `reasoning` — not narrated to the user yet (logged, not
  spoken), a real, ready seam for a richer Talker to attach to later
  without touching the loop again. `act`/`obs` aren't consumed for
  anything user-facing either, same reasoning — this step builds the
  real stream and a real (if currently minimal) consumer, not a fuller
  narration UI nothing has asked for yet.
- The typed/HTTP transport (`index.tsx`) is **not** wired to `onEvent` at
  all this step — a real, honest scoping call, not an oversight: there's
  no Plan/Critic wiring on that transport (steps 2-3's own deferred wire-
  contract dependency, still unresolved), so there would be no real
  `thk` events to project there yet, and the typed loop has no ack
  mechanism to migrate in the first place. Wiring `onEvent` there today
  would only ever emit `act`/`obs` with nothing meaningful consuming
  them — deferred until there's a real reason to, not built speculatively.

**Tests:** `index.test.ts` (in `@cairnvibe/core`) gained 6 for
`AgentEventSchema` — all four real variants validating, an invented
event type rejected, and confirming the discriminated union still
enforces the real embedded `VerbResponseSchema` on `act` (not just its
own top-level shape). `agent-loop.test.ts` gained 5: `act`-then-`obs`
ordering for a real continuing step: `ok: false`'s real semantics (fires
even on a null/undefined executeStep result — "a result arrived," not
"the action succeeded"); `act` never fires for an `onStep`-aborted step;
`obs` never fires for an `onStepResult`-aborted step; and a caller's own
`onStep`/`runCritic` closures genuinely emitting `inj`/`thk` through the
same shared callback. All 14 of `realtime-server.test.ts`'s existing
tests — including every step 1-4 test — pass **completely unmodified**,
and (a genuinely useful side effect of the migration) their own console
output now shows the real event stream firing correctly, in the right
order, across every scenario shape already covered: single-step,
multi-step advancement, batch, a Critic give-up, and the iteration-cap
path. Full monorepo typecheck + 357-test suite passing.

**Live-verified (partial, by design):** rebuilt `packages/sdk` and
confirmed zero regression against the real running demo-app (clean
reload, no server/console errors) — but this step's actual new code
(the event stream, the ack's migration to an `inj`-event consumer) only
runs on the realtime/voice transport, which the typed-transport check
above doesn't exercise at all. A full live voice call (the fake-mic
technique from `packages/evals`, plus a running `cairn-realtime`
process) would be the only way to live-verify this step's real change
end to end; judged disproportionate to set up for a change that's
purely additive observability with no discernible effect on what the
user actually hears — the realtime-server.test.ts suite's own real,
scenario-shaped console output (rather than a mocked assertion alone)
was treated as sufficient evidence the event stream fires correctly, in
the right order, in every real shape already covered.

**Pending / not yet started — Phase 3 build order complete, real
follow-ups tracked honestly:**
- The typed/HTTP transport's Plan/Critic/event wiring — the SAME
  deferred wire-contract dependency named in steps 2, 3, and now this
  one too. A real, concrete piece of follow-up work, not three separate
  gaps — one wire-contract change (`{verb, plan?, progress?}` on
  `CopilotRequestSchema`/the copilot response, additive per the plan's
  own backward-compatibility risk analysis) would close all three at once.
- A full live voice-call verification of this step's real change,
  blocked on setup complexity rather than any known issue.
- `thk`/`act`/`obs` events aren't narrated/surfaced to the user anywhere
  yet — logged only. A richer Talker (a real status-text projection on
  the typed transport per the plan's own optional suggestion; genuine
  narration of Critic reasoning on voice) is real, valuable follow-up
  work, deliberately not built speculatively in this step.
- This closes Phase 3's 5-step build order as approved. Per the original
  plan, Phases 2/4/5 (voice architecture upgrade, deep runtime context,
  memory) each get their own focused plan-and-approval pass when picked
  up next — none started.

## Phase 4 — deep runtime context

Phase 3 gave the Planner an architecture (`resolvePlan`) but no real
knowledge of the target app beyond page structure — it decomposes a goal
into tasks knowing only routes/titles/purposes, never what data actually
flows through a page or what shape it's in. The plan's own Phase 4
section names six layers; layer 2 ("data shapes") was picked to go
first, per the plan's own reasoning — the indexer already depends on
`ts-morph`, so reading real type definitions is an extension of existing
machinery, not a new tool, and it's the layer research (a live Explore
pass over `l1-scan.ts`, `manifest.ts`, `packages/core`'s `ManifestSchema`,
and `server.ts`'s two prompt-injection points) confirmed was genuinely
tractable against how this codebase's own demo app — and real apps like
it — actually write data-fetching code.

### Step 1: data shapes — real interface/type-alias fields surfaced per page

**Built:**
- `DataFieldSchema`/`DataShapeSchema` in `packages/core/src/index.ts` —
  `{name, fields: [{name, type, optional}], source}`. `type` is the
  field's type-node source text verbatim (e.g. `"Paid" | "Overdue" |
  "Archived"`), not a resolved/normalized type — the agent sees exactly
  what a developer wrote. `PageSchema` gains an optional `dataShapes`
  field — additive, same pattern as `ElementSchema.apiCall`, so a
  manifest written before this field existed still validates.
- `packages/indexer/src/l1-data-shapes.ts` — `extractDataShapes(project,
  absRoot, reachableAbsFiles)`. For every file reachable from a page
  (L1 already computes this set), walks every `CallExpression` with a
  plain-identifier callee, resolves it to an imported function/arrow
  declaration, and — only when that declaration has an EXPLICIT
  return-type annotation (never the type checker's inferred type; same
  "read syntax, not semantics" determinism discipline as the rest of L1)
  — resolves the named type to an `interface` or object-shaped `type`
  alias and reports its fields. Handles `T[]`, `T | null`/`T |
  undefined`, and — the real gap the live check against demo-app
  surfaced first-hand — a type only *imported* into the calling file
  rather than declared there (the `board.ts`/`board-types.ts` split-file
  convention, a common real pattern for keeping a server-only import out
  of a "use client" bundle), via a one-hop fallback into the file's own
  imports. Union/primitive type aliases correctly report no fields
  (nothing to shape) rather than crashing or guessing.
- Wired into `l1-scan.ts` (`RawPage.dataShapes`, computed per page
  alongside `reachableFiles`/`elements`) and `manifest.ts`
  (`assembleManifest` passes it straight through onto `Page.dataShapes`,
  same as `dead`/`conflicts` — no LLM involvement, this is pure L1).
  `crawl.ts`'s runtime-DOM mode sets `dataShapes: []` explicitly (no
  source file to read when crawling a live URL instead of reading disk).

**Tests:**
- `packages/indexer/src/l1-data-shapes.test.ts` (new, 9 tests, isolated
  in-memory ts-morph projects) — same-file interface resolution; the
  cross-file import-chasing case (mirrors `board.ts`/`board-types.ts`
  exactly); nullable unwrapping; object-shaped type alias; optional
  fields; a function with NO explicit return-type annotation correctly
  yields no shape (proves the determinism boundary is real, not just
  documented); a union type alias correctly yields no shape; dedup +
  sorted output when multiple calls return the same shape; an
  unresolvable reachable file doesn't crash.
- `l1-scan.test.ts` (+1): every page gets a `dataShapes` array (possibly
  empty) — proves the wiring without touching the shared `simple-app`
  fixture other suites (l2-reachability, l3-describe, crawl) also
  depend on.
- `manifest.test.ts` (+2, new `assembleManifest` coverage — this file
  previously only tested `parseApiCall`): a page's L1 `dataShapes`
  passes straight through onto the manifest `Page` unchanged, both
  populated and empty.
- `packages/core/src/index.test.ts` (+3): `DataShapeSchema` accepts a
  well-formed shape; `PageSchema` accepts a page with real `dataShapes`;
  `PageSchema` still accepts a page with the field omitted entirely
  (backward compatibility with pre-existing manifests).
- Full regression gate: 372/372 tests pass across the whole repo
  (`npx vitest run`, no scope narrowing) — zero regressions. Full
  repo-wide `npm run typecheck` (all 6 workspaces) also clean.

**Live-verified:** ran `scanL1` directly against the REAL
`examples/demo-app` source (not a fixture) via a disposable script,
same convention as this session's `packages/evals/scratch-test.ts`
checks, deleted after use. Confirmed against three real, independently
data-shaped pages:
- `/invoices` → `Invoice` from `lib/invoices.ts`, fields `id`/`client`/
  `amount`/`status`, with `status`'s real literal union
  `"Paid" | "Overdue" | "Archived"` surfaced verbatim — the exact
  concrete example the research pass and this step's design were built
  around.
- `/board` → `BoardColumn` from `lib/board-types.ts` (found only via the
  cross-file import-chasing fallback — the FIRST version of this code,
  without that fallback, returned `[]` for this page; a real bug the
  live check caught before it shipped, not a hypothetical), including
  its nested `cards: BoardCard[]` field.
- `/shop` and `/shop/checkout` → `Product`/`CartLine`.
Ran across all 9 of demo-app's real pages with zero crashes; the
remaining 6 pages correctly report no data shapes (either no
explicit-return-typed data call in their reachable set, or a shape this
step deliberately doesn't chase yet — see Pending) rather than guessing.

**Pending:**
- Not yet wired into what the Planner/model actually sees —
  `server.ts`'s `buildPageElements` (the per-request, uncached
  injection point the research pass identified as the natural
  integration seam, since `buildSystemPrompt`'s cached page-list is
  explicitly budget-constrained and scales with page count only) still
  only sends element `id (does)` pairs. This step is the extraction
  layer alone, deliberately kept separate and independently tested
  before touching what reaches the LLM — the next step.
- Anonymous/inline-asserted shapes (e.g. `db.prepare(...).get() as
  {count: number}`, seen for real in `lib/invoices.ts`) have no named
  declaration to point to — out of scope for v1, correctly reported as
  "no shape" rather than guessed.
- A shape referenced by prop-drilling through several component layers
  with only an inferred (not annotated) prop type isn't traced —
  attributing it to the originating function's own explicit return type
  (this step's actual behavior) rather than the leaf component is the
  deliberate, documented boundary from the research pass, not an
  oversight.
- Nested named types (`BoardColumn.cards: BoardCard[]`) are reported by
  name/type-text only, not recursively expanded into their own
  `DataShape` entry — a real, reasonable v2 enhancement, not attempted
  here to keep this step's scope to what the plan's own text asked for.
- Remaining Phase 4 layers (business rules & state machines, docs/copy
  mining, the unified tools/skills inventory, the runtime dependency
  graph) — not started; sequencing beyond this first step still
  undecided, per the plan's own "sequencing gets decided in this
  phase's own focused plan" note.

**Failed:** nothing — no dead ends this step; the one real bug found
(cross-file type resolution) was caught by live verification against
demo-app before being called done, not shipped and found later.

### Step 2: wiring data shapes into what the model actually sees

Step 1 built the extraction layer but deliberately stopped there —
`Page.dataShapes` existed in the manifest but nothing read it. This step
closes that loop: real data shapes now reach `resolveVerb` (shared by
both the HTTP and realtime transports), the same place `currentPageElements`
already does.

**Built:**
- `buildPageDataShapes(manifest, route)` in `packages/sdk/src/server.ts`
  — mirrors `buildPageElements`'s own shape/placement exactly: per-request,
  scoped to the current page only, never baked into the cached
  route-independent system prompt (the same real-world token-budget
  lesson `buildPageElements`'s own doc comment already documents — this
  is more app-size-scaling detail, so it stays out of what has to scale
  with page *count* only). Formats each shape as `Name { field: type,
  field?: type }` — e.g. `Invoice { amount: string, client: string, id:
  string, status: "Paid" | "Overdue" | "Archived" }` — a compact,
  readable rendering of exactly the literal type text l1-data-shapes.ts
  traced, optional fields marked with `?`.
- `resolveVerb`'s userMessage gains a `currentPageDataShapes` field
  alongside the existing `currentPageElements`, `liveElements`,
  `webMcpTools`. Degrades to the string `"none"` — never a crash, never
  an empty string — for a page with no traced shapes, a route with no
  manifest entry at all, or a manifest built before this field existed
  (the `Page.dataShapes` field is optional, from step 1).
- `buildSystemPrompt` documents `currentPageDataShapes` as a fifth named
  context source (alongside the route directory, currentPageElements,
  liveElements, webMcpTools), with explicit guidance: use it to know a
  field's REAL possible values (what `status` can actually be set to)
  instead of guessing from a button label, and don't read `"none"` as
  "this page has no data" — just don't invent field names/values for it.
  This directly targets a failure mode a blind agent would otherwise
  have no defense against: filling a status field with a plausible-
  sounding value that isn't actually one of the app's real states.
- Both `createCopilotHandlerWithLLM` (HTTP/typed) and `finalizeTurn`
  (realtime/voice) get this for free — both call the same shared
  `resolveVerb`, confirmed by re-reading `realtime-server.ts` before
  touching anything, so there was no second call site to duplicate this
  into.

**Tests:**
- `server.test.ts` (+4): the current page's real data shapes arrive in
  the request payload scoped to that page only (using a new
  `dataShapes: [Invoice {...}]` entry added to this file's shared
  `manifest` fixture); a manifest that never sets `dataShapes` at all
  (the `manifestWithPages` 17-page fixture — the genuine "pre-existing
  manifest" case) degrades to `"none"`, not a crash; a route with no
  manifest entry also gets `"none"`; data shapes never leak into the
  cached system prompt (only the *concept* is documented there, not any
  page's real field data) — the same discipline the existing
  12,402-token production-bug regression tests already enforce for
  `currentPageElements`, extended to cover this new field explicitly.
- Full regression gate: 376/376 tests pass repo-wide, zero regressions
  (61/61 in `server.test.ts` alone, 57 pre-existing + 4 new). Full
  repo-wide `npm run typecheck` clean across all 6 workspaces.

**Live-verified:** built a REAL manifest from the real `examples/demo-app`
source (`scanL1` → `computeL2` → `assembleManifest`, L3's LLM describe
step skipped on purpose — not needed to prove this step's wiring and
avoids spending a live LLM call on a check that isn't testing L3), ran
it through the actual `createCopilotHandlerWithLLM` with a
capturing fake LLM (same technique `server.test.ts` already uses), and
asked "what statuses can an invoice have?" on `/invoices`. The real
captured `userMessage` carried:
`currentPageDataShapes: Invoice { amount: string, client: string, id:
string, status: "Paid" | "Overdue" | "Archived" }` — the exact real
literal union, delivered end-to-end from real source code through the
real manifest through the real prompt-construction path, with zero
hand-authored test data anywhere in the chain. Confirmed the system
prompt correctly documents the new concept. Scratch script deleted
after use, same convention as step 1's and this session's other
disposable live checks.

**Pending:**
- Not yet wired into `resolvePlan` — the Planner still decomposes a
  goal knowing only the bare goal string, no page/data context at all.
  This is a real, bigger gap than this step closes: it needs a design
  decision (which pages' context is even relevant to a given goal, how
  to keep it within the Planner's own token budget for an app with many
  data-shaped pages) rather than the same direct wire-through this step
  used for the single-page-scoped Executor prompt. Real follow-up work,
  not started.
- No live voice-call verification of this step specifically (it's a
  shared-`resolveVerb` change, and step 1's realtime coverage precedent
  already established why a full voice-call setup is disproportionate
  for a change with no realtime-specific code path — same reasoning
  applies again here, not re-litigated).
- Remaining Phase 4 layers (business rules & state machines, docs/copy
  mining, the unified tools/skills inventory, the runtime dependency
  graph) — still not started.

**Failed:** nothing.

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

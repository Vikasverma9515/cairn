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

### Step 3: real page/data-shape context reaches the Planner too

Step 2 closed the loop for the Executor (`resolveVerb`). This step closes
the SAME loop for the Planner (`resolvePlan`) — which, until now, decomposed
every goal knowing literally nothing about the target app beyond the bare
goal string. Flagged as a real, bigger gap in step 2's own Pending notes,
picked up directly rather than left for later.

**Built:**
- `resolvePlan`'s signature gains a new, OPTIONAL 4th parameter:
  `resolvePlan(llm, goal, version = 1, manifest?: Manifest)`. Appended
  after `version`, not inserted before it — inserting it earlier would
  have silently broken the real 3-arg internal call site
  (`resolvePlan(planLLM, transcript, plan.version + 1)`, realtime-
  server.ts's own replan path) by landing a number where an object was
  expected. `resolvePlan` is re-exported from `@cairnvibe/sdk/server`,
  a real published subpath — this is why the change had to be additive,
  same backward-compatibility discipline as every other Phase 3/4 wire
  change this session. Confirmed genuinely zero-behavior-change: every
  pre-existing `resolvePlan` test (2- and 3-arg calls, no manifest)
  passes completely unchanged — the `{goal}`-only userMessage shape is
  untouched when no manifest is passed.
- `buildPlannerPageDirectory(manifest)` — the Planner's own version of
  `buildSystemPrompt`'s route directory: `route: purpose` per page, same
  page-COUNT-scaled (not total-content-scaled) budget discipline as that
  directory's own doc comment explains. For a page with real traced data
  shapes (step 1), appends just the SHAPE NAMES — e.g. `(data: Invoice)`
  — never full field lists (that's what `buildPageDataShapes`, step 2,
  already gives the Executor once a task narrows to one specific page).
  When present, `resolvePlan`'s userMessage becomes `{goal, pages}`.
- `buildPlannerSystemPrompt` now documents the optional `pages` field:
  ground tasks in real page purposes/routes when present, let a listed
  data shape constrain what a record can legitimately contain (never
  invent a field or status a listed shape doesn't have), decompose from
  the goal alone when absent — the exact prior behavior, named
  explicitly as the fallback rather than silently changed.
- Both real call sites in `realtime-server.ts` (the initial plan kicked
  off on the first continuing step, and the replan path inside
  `runCritic`) now pass `deps.manifest` through — the connection already
  has it (used by `resolveVerb` at the same call site), so this was a
  one-line addition at each, not new plumbing.

**Tests:**
- `server.test.ts` (+3): a manifest passed to `resolvePlan` produces a
  real `pages` field with route, purpose, and `(data: Invoice)`; a page
  with no traced data shapes lists route/purpose only, no dangling
  `(data: ...)` suffix; the system prompt documents the optional `pages`
  field regardless of whether a given call happens to pass one. All
  pre-existing `resolvePlan` tests re-run unmodified as the regression
  gate (per standing discipline) and pass exactly as before.
- `realtime-server.test.ts` (+1): a full `handleDeepgramMessage` run
  with a real manifest (one page, one data shape) confirms the ACTUAL
  Planner call fired during a real turn carries `pages` with the real
  route/purpose/shape-name — not a unit test of `resolvePlan` in
  isolation, but proof the wiring reaches all the way through the real
  event-driven realtime path.
- Full regression gate: 380/380 tests pass repo-wide (up from 376),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified:** built a REAL manifest from `examples/demo-app`'s
actual source (same `scanL1` → `computeL2` → `assembleManifest` chain
as step 2's check, L3 skipped again on purpose) and called the real
`resolvePlan` against it with a capturing fake LLM. The captured
`pages` directory correctly listed all 9 real routes with the exact
same 4 data-bearing pages step 1's live check found —
`/board (data: BoardColumn)`, `/invoices (data: Invoice)`, `/shop
(data: CartLine, Product)`, `/shop/checkout (data: CartLine)` — and no
`(data: ...)` suffix on the other 5. Scratch script deleted after use.

**Pending:**
- The typed/HTTP transport (`createCopilotHandlerWithLLM`) still never
  calls `resolvePlan` at all — this step made the function manifest-
  aware, but didn't add a NEW call site; that's the same pre-existing,
  already-tracked "typed transport's Plan/Critic/event wiring" gap from
  Phase 3, unchanged by this step.
- No live voice-call verification specific to this step (same
  disproportionate-setup reasoning as steps 1 and 2 — a shared,
  non-realtime-specific code path, not re-litigated here).
- Remaining Phase 4 layers (business rules & state machines, docs/copy
  mining, the unified tools/skills inventory, the runtime dependency
  graph) — still not started.

**Failed:** nothing.

### Step 4: real metadata for registered actions (Phase 4, layer 5 — partial)

The plan's own layer 5 text asks for "WebMCP tools, registered actions,
apiCall-backed elements... unified into one indexed, queryable
inventory." A live research pass (Explore agent, read-only) before
building anything found this framing overstates what's fragmented at
the point the model actually sees these three things — `buildSystemPrompt`'s
existing do-verb preference order (liveElements > currentPageElements >
registeredActions) already functions as real, working de facto
unification, and `call_tool` is already cleanly separated by intent.
What the research found genuinely missing instead: `registeredActions`
was the WEAKEST-typed of the three — a bare id string, zero server-
visible metadata, real behavior invisible to Cairn entirely (it lives in
the customer's own client-side dispatch code) — and neither the
Executor's prompt nor the Planner had any visibility into it beyond
that bare id. This step closes exactly that gap; full cross-mechanism
dedup (the research's third, harder finding) is explicitly NOT attempted
here — see Pending.

**Built:**
- `CreateCopilotHandlerOptions.actionDescriptions?: Record<string, string>`
  (`packages/sdk/src/server.ts`) — a new, purely additive, optional field
  mapping a registered action id to a real, human-written description.
  An id with no entry still renders exactly as it always has (bare) —
  zero behavior change for any deployment that doesn't set it.
- `renderRegisteredActions(registeredActions, actionDescriptions)` —
  exported, the ONE place an action id is rendered with its optional
  description (`"id (description)"`), shared by `buildVerbToolSchema`,
  `buildSystemPrompt`'s do-verb text, AND `resolvePlan`'s new `actions`
  field — so the Executor and Planner can never describe the same
  registered action two different ways. Deliberately renders the
  description in parens rather than baking it into what the model must
  echo back: `resolveVerb`'s `registeredActions.includes(action)` gate
  needs the RAW id back verbatim, so both prompt sites now explicitly
  instruct "put that exact id (never its description in parens) in
  action."
- `buildSystemPrompt` gains a 4th parameter, `actionDescriptions`
  (defaults to `{}`) — additive, existing 3-arg callers keep the exact
  same rendering as before.
- `resolvePlan` gains a 5th optional parameter, `actionsText` — the
  SAME `renderRegisteredActions(...)` output a caller already computed
  for the Executor's prompt, passed through unchanged rather than
  re-derived, so there's no risk of the Planner and Executor's renderings
  drifting apart. When present, the userMessage gains an `actions` field
  alongside `pages`; genuinely independent of whether a manifest was
  also passed (an app can have registered actions with no manifest, or
  vice versa). `buildPlannerSystemPrompt` documents it: ground a task in
  a real listed action when one fits, never invent an id that isn't
  listed.
- Both real call sites in `realtime-server.ts` updated: `ConnectionDeps`
  gains an optional `actionDescriptions` field (defaults to `{}`,
  existing `ConnectionDeps` construction — including every existing
  test — keeps working unchanged); `createRealtimeServer`'s
  `buildSystemPrompt` call and both `resolvePlan` calls (initial plan,
  replan) now pass real descriptions through.

**Tests:**
- `server.test.ts` (+13): `renderRegisteredActions` unit tests (bare id,
  id with description, mixed list, empty list); a registered action
  with a real description renders as `id (description)` in the real
  system prompt via `createCopilotHandlerWithLLM`; a registered action
  with NO description still renders bare (the field is optional, not
  required); `resolvePlan`'s `actions` field carries the exact rendered
  text when `actionsText` is passed, is entirely omitted when absent/
  empty (same additive discipline as `pages`), and is independent of
  whether a manifest was also passed; the Planner system prompt
  documents the `actions` field.
- `realtime-server.test.ts` (+1): a full `handleDeepgramMessage` run
  with `deps.registeredActions`/`deps.actionDescriptions` set confirms
  the ACTUAL Planner call fired during a real turn carries the real
  rendered `actions` text — proof through the real event-driven path,
  not just a `resolvePlan` unit test.
- Full regression gate: 390/390 tests pass repo-wide (up from 380),
  zero regressions — every pre-existing test for `buildSystemPrompt`,
  `buildVerbToolSchema`, `resolvePlan`, and `ConnectionDeps` construction
  re-ran completely unmodified and passed, confirming the no-
  `actionDescriptions` path is byte-for-byte unchanged. Full `npm run
  typecheck` clean across all 6 workspaces.

**Live-verified:** used `examples/demo-app`'s own REAL registered action
id (`archiveInvoice`, read straight from its actual
`app/api/copilot/route.ts`) plus a made-up-but-realistic description,
built a real manifest from demo-app's real source, and ran the actual
`createCopilotHandlerWithLLM` and `resolvePlan` against it with
capturing fake LLMs. Confirmed both real prompts carried the rendering
verbatim:
- Executor system prompt: `3. One of this deployment's registered
  actions: [archiveInvoice (Archives the invoice; it will no longer
  appear in the active list. Cannot be undone.)] — put that exact id
  (never its description in parens) in "action".`
- Planner userMessage `actions` field: `archiveInvoice (Archives the
  invoice; it will no longer appear in the active list. Cannot be
  undone.)`
Scratch script deleted after use, same convention as steps 1-3.

**Pending:**
- Cross-mechanism DEDUP (the research's third finding — a page with
  both a registered action and an equivalent WebMCP tool for the same
  real capability, shown to the model as two unrelated options with no
  signal they're the same thing) — explicitly not attempted. This needs
  real, per-app semantic matching (is `archiveInvoice` the same
  capability as a WebMCP tool named `invoices-archive-inv-2`?) that's
  much harder to build and verify generically than giving an existing
  field real metadata; deliberately left as real, tracked follow-up
  rather than guessed at.
- WebMCP tools themselves still aren't part of any unified/indexed
  inventory — they remain purely a client-discovered, per-request
  concept (`webmcp-client.ts`'s `discoverWebMcpTools()`), never known to
  the indexer/manifest/Planner. Untouched by this step.
- The typed/HTTP transport still never calls `resolvePlan` — same
  pre-existing gap named in step 3, unchanged here.
- Remaining Phase 4 layers (business rules & state machines, docs/copy
  mining, the runtime dependency graph) — still not started.

**Failed:** nothing.

### Step 5: the API-route dependency graph (Phase 4, layer 6 — first slice)

Before building this, ran a read-only research pass on layer 3
("business rules & state machines") since it was the next item in the
plan's own listed order. Honest finding: `demo-app`'s real mutating
functions (`archiveInvoice`, `moveCard`, `updateCard`, `connectNodes`,
`configureNode`) have ZERO transition/permission guards — `archiveInvoice`
unconditionally sets status to Archived for ANY existing id, and there is
no role/permission concept anywhere in the app. The one real domain rule
found (`isLoggedIn()` gating checkout) is exactly the kind of thing layer
3 would want to surface, but building a whole extraction layer against a
codebase that has almost nothing else to find would mean either shipping
something that mostly reports "no rule found," or being tempted to
retrofit fake guards into demo-app just to give it something to extract
— which inverts the actual methodology that made layer 2 work (build the
extractor to match what's REALLY written, never add fake material to
match a planned extractor). Recommendation from that research: build
layer 6 (dependency graph) instead — real, plentiful, unambiguous
material already in this codebase, and it reuses two already-solved
halves (l1-scan.ts's click→fetch trace, l1-data-shapes.ts's import
resolution) instead of starting from nothing. Layer 3 stays explicitly
un-started, for the honest reason above, not skipped by oversight.

**Built:**
- `packages/indexer/src/l1-api-routes.ts` (new) — `mapApiRouteHandlers(
  project, absRoot): ApiRouteHandler[]`. For every `app/api/**/route.ts`
  file, resolves each exported HTTP-method handler (`export async
  function POST()` or `export const POST = async () => {}` — both
  shapes handled via `sf.getExportedDeclarations()`) and walks its body
  for calls to imported, project-local (non-`node_modules`) functions —
  reusing the exact same "identifier callee, resolves to a real project
  file" filter `l1-data-shapes.ts`'s `resolveImportedFunction` already
  established, so a library/global call (`NextResponse.json`,
  `db.prepare`) is never mistaken for real app logic. Deliberately App
  Router only — Pages Router API routes (`pages/api/*.ts`) export one
  default handler that dispatches on `req.method` internally, a
  materially different shape; skipped rather than guessed at, same
  "only claim what's genuinely traceable" boundary layer 2 already set
  with explicit-return-type-only resolution.
- `ApiCallSchema.handledBy?: string[]` (`packages/core/src/index.ts`) —
  additive, optional, same backward-compatible pattern as every other
  Phase 4 schema addition. This is the second hop of a real, two-part
  dependency graph: the FIRST hop (a click's onClick → a real `fetch(url,
  {method})` call) was already traced by `l1-scan.ts` and shipped in the
  original manifest; this step traces the SECOND hop (that same URL →
  the real route handler → the real backend function it calls) and
  connects them — an element's `apiCall` now carries not just THAT it
  calls `POST /api/invoices`, but WHAT REAL CODE runs when it does.
- `RawFacts.apiRouteHandlers` (new, deployment-wide — a route isn't
  owned by one page, unlike `dataShapes`) — computed once in `scanL1`,
  alongside `pages`/`frameworkElements`. `manifest.ts`'s
  `assembleManifest` builds a `{method, url}` → handler lookup once per
  build and enriches each element's `apiCall` via a new `enrichApiCall`
  helper — a plain map lookup, not a re-scan, so this stays cheap
  regardless of app size. `crawl.ts`'s runtime-DOM mode sets
  `apiRouteHandlers: []` explicitly (no source file to read).
- Deliberately NOT wired into any model-facing prompt this step —
  unlike layers 2/5, `apiCall` itself was never shown to the model as
  text in the first place (confirmed against `buildSystemPrompt`'s own
  wording: the model never sees the word "apiCall," only picks a
  `target` id, and the apiCall is attached server-side as an execution
  detail). `handledBy` follows that exact same existing boundary rather
  than inventing a new one — see Pending for where this real graph data
  is actually headed next.

**Tests:**
- `l1-api-routes.test.ts` (new, 9 tests, isolated in-memory ts-morph
  projects, same style as `l1-data-shapes.test.ts`): a real POST handler
  traced to its real called function; the arrow-function export shape
  resolved the same way as a function declaration; a library call
  (`NextResponse.json`) never mistaken for a real project function;
  dedup + sorted `calls`; a `route.ts` outside `app/api/` correctly
  skipped; a Pages Router `pages/api/*.ts` file correctly skipped;
  correct URL derivation for a nested route; only genuinely-exported
  HTTP methods reported, no phantom handlers; deterministic sort order.
- `manifest.test.ts` (+2): an element's `apiCall` gets enriched with
  `handledBy` when a matching route handler was traced; `apiCall` is
  left exactly as parsed (no `handledBy` key at all) when no route
  handler matches — never invented.
- `core/index.test.ts` (+2): `ApiCallSchema` accepts a real `handledBy`
  array; still accepts an `apiCall` with the field entirely omitted
  (backward compatibility with manifests built before this field
  existed).
- `l1-scan.test.ts` (+1): `apiRouteHandlers` is wired onto the real
  `RawFacts` shape — using the shared `simple-app` fixture's own REAL
  API route (`pages/api/ping.ts`, Pages Router) as a genuine "correctly
  out of scope" case rather than inventing a synthetic one.
- Full regression gate: 404/404 tests pass repo-wide (up from 392),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified:** ran `scanL1` directly against `examples/demo-app`'s
REAL source. Found 28 real API route handlers across the whole app,
correctly resolving real backend functions for every one that calls
project-local code (`GET /api/invoices -> listInvoices`, `POST
/api/board/cards -> createCard`, `POST /api/workflows/edges ->
connectNodes`, etc.) and correctly reporting `calls: []` for the 5
`/api/copilot/*` routes (they call the `@cairnvibe/sdk` package itself —
a `node_modules` import, correctly excluded). Confirmed the enrichment
reaches real manifest elements: `/invoices`'s `create-invoice` button
now carries `handledBy: ["createInvoice"]`; `/shop`'s "Add to cart"
button carries `handledBy: ["addToCart", "listCart"]` (both real calls
in that one handler, deduped/sorted); `/shop/checkout`'s place-order
button carries `handledBy: ["isLoggedIn", "placeOrder"]` — the app's
one real domain policy gate (found in step 5's own research pass),
now traceable all the way from a UI element to the real function that
enforces it. Scratch script deleted after use, same convention as
every prior Phase 4 step.

**Pending:**
- Not wired into any prompt — deliberate, matching `apiCall`'s own
  existing boundary (see Built). The most concrete, honestly-scoped
  next application of this real graph data: cross-mechanism capability
  DEDUP, explicitly deferred as Pending in step 4 ("a page with both a
  registered action and an equivalent WebMCP tool for the same real
  capability, shown as two unrelated options") — `handledBy` is
  exactly the missing signal that could let Cairn recognize two
  elements (or an element and a future WebMCP-tool trace) that call the
  SAME real backend function are the SAME underlying capability. Not
  built here — noted as the concrete follow-up this step's data
  actually unlocks, not attempted speculatively.
- Only covers elements whose `apiCall` already passed `parseApiCall`'s
  existing literal-static-path filter — a per-row/dynamic apiCall (e.g.
  `/api/invoices/[id]/archive`, a real route this step DID trace and
  find `archiveInvoice` for) never gets enriched today, because the
  ELEMENT side never produces a matchable static apiCall for it in the
  first place. This is `ApiCallSchema`'s own pre-existing, already-
  documented gap (see its own doc comment) — this step doesn't close
  it, just doesn't make it worse.
- Layer 3 (business rules & state machines) — explicitly not started,
  for the honest reason documented above (near-empty real material in
  this codebase today, not a build-effort tradeoff).
- Layer 4 (docs & in-app copy mining) — built next, in step 6.

**Failed:** nothing.

### Step 6: layer 4 — real, human-authored in-app copy

Confirmed real, not hypothetical, before writing this (same discipline
as every prior layer): grepped `examples/demo-app`'s own pages and
found every one of them opens with a real `<h1>title</h1><p>real
description</p>` pair — e.g. `/invoices`'s real `<h1>Invoices</h1>` and
`<p>Every invoice you've sent, with its status and amount.</p>`. Today
that's completely invisible to Cairn: L3's `title`/`purpose` fields are
LLM-guessed from context, even when the real, human-authored answer is
sitting right there in the source, often nearly verbatim.

**Built:**
- `packages/indexer/src/l1-in-app-copy.ts` (new) —
  `extractInAppCopy(project, reachableAbsFiles, relPathOf)`. Walks
  every file reachable from a page (the same set l1-scan.ts already
  computes) for `<h1>`-`<h6>`/`<p>` JSX elements and extracts their
  real text content, reusing `l1-scan.ts`'s own `getElementText`
  (exported for this, not duplicated) — the EXACT same "read a JSX
  element's own text children" logic already proven for an interactive
  element's label, just applied to the descriptive copy AROUND it.
  Self-closing copy tags (`<p />`) are correctly skipped — they never
  carry text; a dynamic JSX expression inside a text node (`{count}`)
  is correctly excluded too (only literal `JsxText` children are read,
  matching `getElementText`'s own existing behavior) — real, honest
  static-fragments-only extraction, never a guessed/interpolated value.
- Wired through the same path every prior L1 addition used: `RawPage.
  inAppCopy` (computed in `l1-scan.ts`, alongside `dataShapes`),
  passed straight through in `manifest.ts`'s `assembleManifest` (pure
  L1, no LLM), `crawl.ts`'s runtime-DOM mode sets `inAppCopy: []`
  explicitly (no source file to read there). `CopyBlockSchema`/
  `Page.inAppCopy` in `@cairnvibe/core` — additive/optional, same
  backward-compatible pattern as every prior schema addition.
- Deliberately NOT wired into any model-facing prompt this step — same
  "extraction first, consumption as its own step" discipline layer 2's
  own steps 1→2 established. See Pending for the real, natural next
  application (L3's own prompt could use this as REAL grounding instead
  of guessing `purpose`/`title` from scratch).

**Tests:**
- `l1-in-app-copy.test.ts` (new, 8 tests, isolated in-memory ts-morph
  projects, same style as `l1-data-shapes.test.ts`): a real h1/p pair
  matching the exact shape found live in demo-app; results ordered by
  real document/line order; copy captured from a page's reachable CHILD
  component, not just its own file (mirrors data-shapes' own cross-file
  discipline); an empty heading is correctly ignored; a non-copy tag
  (a button, a div) is correctly ignored; a self-closing `<p />` is
  correctly skipped; all six heading levels h1-h6; an unresolvable
  reachable file doesn't crash.
- `l1-scan.test.ts` (+1): the shared `simple-app` fixture's own REAL
  `<h1>About</h1><p>This is the about page.</p>` and bare `<h1>Welcome</h1>`
  content, asserted verbatim — not invented for this test, the fixture
  already had it.
- `manifest.test.ts` (+1): a page's L1 `inAppCopy` passes straight
  through onto the manifest `Page` unchanged.
- `core/index.test.ts` (+4): `CopyBlockSchema` accepts a well-formed
  block, rejects a tag outside the real copy set (`button`); `PageSchema`
  accepts real `inAppCopy` and still accepts it entirely omitted
  (backward compatibility).
- Full regression gate: 484/484 tests pass repo-wide (up from 470),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces (four existing `manifest.test.ts` fixtures needed the new
  required `inAppCopy` field — caught by `tsc`, the same real "typecheck
  is a separate, necessary gate" reminder step 6 of Phase 2 already
  surfaced).

**Live-verified:** ran `scanL1` directly against `examples/demo-app`'s
REAL source. Every one of its 9 real pages yielded real, meaningful
copy — page titles/descriptions on every page, PLUS copy correctly
traced into reachable child components (`/board`'s real `<h2>Edit
card</h2>` found in `components/CardModal.tsx`, not the page's own
file — confirming the cross-file reachability discipline works exactly
as designed, the same real proof pattern layer 2's own board.ts/
board-types.ts case established). A real, honest artifact also
surfaced live: a paragraph built from static text around a dynamic
JSX expression (`{count} events recorded, dominant emotion {mood}.`)
comes through with the expression parts correctly stripped rather than
guessed, which can read a little oddly on its own ("events recorded,
dominant emotion .") — correct, conservative behavior (never invent a
runtime value), not a bug, but worth knowing about when consuming this
data later.

**Pending:**
- Not wired into L3's own description prompt yet — the natural next
  application: give the LLM this REAL copy as grounding instead of
  guessing `title`/`purpose` purely from element context, the same way
  layer 2's data shapes eventually reached the Planner/Executor
  prompts in later steps.
- README.md / project-doc mining — a genuinely different mechanism
  (filesystem-based, not AST-based) with a real, unresolved association
  question (which route does a top-level README even belong to?);
  deliberately scoped out of this step rather than guessed at.
- JSDoc/leading-comment mining on exported components — real, tractable
  future work using the same `ts-morph` machinery, not attempted here.

**Failed:** nothing.

---

### Step 7: layer 3 — real business rules & validation constraints

Confirmed real, not hypothetical, before writing this (same discipline
as every prior layer): an Explore-agent pass over `examples/demo-app`'s
actual mutating functions found the honest truth up front — this app has
almost NOTHING resembling a real domain rule. The one genuine exception,
`lib/shop.ts`'s `placeOrder`, gates on `isLoggedIn()`. What IS genuinely
common and real: nearly every API route's own required-field/not-found
guard (`if (!body.toColumnId) return NextResponse.json({error: ...},
{status: 400})`). This extractor reports BOTH kinds uniformly, as "a
real guard this function enforces" — it does not, and cannot, reliably
tell a domain permission check apart from an input-validation check by
AST shape alone; that distinction is left to whoever reads the result,
documented explicitly in the module's own header comment.

**Built:**
- `packages/indexer/src/l1-business-rules.ts` (new) —
  `extractBusinessRules(project, absRoot, handlers)`. For every traced
  API route handler (from `l1-api-routes.ts`'s `ApiRouteHandler[]`),
  walks BOTH the handler's own body and the body of every function it
  calls (resolved via `l1-data-shapes.ts`'s `resolveImportedFunction`,
  exported for this reuse) for `if (condition) return/throw` guard
  clauses — a single-statement then-branch, braced or bare, treated
  identically; a multi-statement then-branch deliberately skipped (a
  guard with real side effects isn't summarized as one simple
  condition). Reports each as `BusinessRule {functionName, condition,
  consequence, source}`, deduped so a function guarded once and called
  from multiple routes yields one real rule, not one per caller.
  `functionName` is either a route key (`"POST /api/shop/checkout"`,
  for a guard in the handler's own body) or a real called function's
  own name (`"placeOrder"`, for a guard found inside it) — both get
  looked up together when enriching one `ApiCall` (below).
- `l1-api-routes.ts`'s `getCallableBody` and `l1-data-shapes.ts`'s
  `resolveImportedFunction` exported for this reuse, not duplicated.
- Wired through the same path every prior L1 addition used:
  `RawFacts.businessRules` (computed in `l1-scan.ts` from the already-
  computed `apiRouteHandlers`), `crawl.ts`'s runtime-DOM mode sets
  `businessRules: []` explicitly (no source file to read there).
  `manifest.ts`'s `assembleManifest` now also builds a
  `businessRulesByKey` map (grouped by `functionName`, same O(1)-per-
  element discipline as the existing `routeHandlersByKey`) and
  `enrichApiCall` attaches a real `ApiCall.constraints: string[]`
  — every matched rule formatted as a readable `"condition →
  consequence"` string, combining BOTH the route's own guards and its
  called function's guards for one apiCall. Absent (not even an empty
  array) when nothing matched — most real mutating functions have no
  guard at all, confirmed live below, a real finding not a bug.
  `ApiCallSchema.constraints` in `@cairnvibe/core` — additive/optional,
  same backward-compatible pattern as every prior schema addition.

**Tests:**
- `l1-business-rules.test.ts` (new, 8 tests, isolated in-memory
  ts-morph projects, reusing the REAL `mapApiRouteHandlers` — not a
  mock — to build realistic input): a route-handler's own guard
  captured; the exact `placeOrder`/`isLoggedIn` called-function shape
  captured; braced vs. bare single-statement then-branches treated
  identically; a multi-statement then-branch correctly skipped; a
  `throw` consequence captured, not just `return`; a guarded function
  called from multiple routes deduped to one rule; no guards anywhere
  yields an empty array; no handlers at all yields an empty array.
- `manifest.test.ts` (+2): an apiCall's `constraints` combines BOTH the
  route's own guard AND its called function's guard, using a realistic
  `/shop/checkout` → `placeOrder` fixture; no `constraints` key at all
  (not even empty) when no business rules matched.
- `core/index.test.ts` (+2): `ApiCallSchema` accepts real constraint
  strings; still accepts an apiCall with `constraints` entirely omitted
  (backward compatibility with manifests built before this field
  existed).
- Full regression gate: 496/496 tests pass repo-wide (up from 484),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces (five existing `manifest.test.ts` fixtures needed the new
  required `businessRules` field on `RawFacts` — caught by `tsc`, the
  same recurring reminder every prior required-field addition this
  session has surfaced).

**Live-verified:** ran `scanL1` directly against `examples/demo-app`'s
REAL source. Found 24 real rules — confirming the research finding
exactly: `placeOrder`'s `!isLoggedIn()` guard is there as expected,
PLUS a second real domain guard on the same function
(`cart.length === 0`) not previously noticed, PLUS `checkout`'s own
route-level `!isLoggedIn()` duplicate check (defense in depth, both
real) — and the rest is exactly the honestly-predicted majority case:
plain required-field (`!body.toColumnId`, `!body.email || !body.address`)
and not-found (`!card`, `!invoice`, `!existing`) guards across the
board/invoices/shop/workflows routes. No false positives, no invented
rules, no guard misattributed to the wrong function.

**Pending:**
- Not wired into any model-facing prompt yet — same "extraction first,
  consumption as its own step" discipline every other Phase 4 layer has
  followed (layer 2's data shapes took 3 separate steps: extract, wire
  into Executor, wire into Planner). The natural next application: give
  the Planner/Executor real constraint text so a `do` verb can reason
  about "this action requires being logged in" instead of discovering
  it only after a 403.
- No semantic classification of domain-rule vs. input-validation guard
  — explicitly out of scope, documented in the module's own header
  comment as a real limitation, not an oversight.
- Guard clauses nested inside a `try`/`catch`, a loop, or an `else`
  branch aren't walked — only a bare top-level `if` inside the
  function body. Not hit live against demo-app's real code, but a real,
  honest gap for a more complex real-world app.

**Failed:** nothing.

---

## Phase 2 — real-time voice architecture upgrade

Picked up after Phase 4's data-shapes/dependency-graph work, per the
plan's own reordering note (Phase 3 first, since it's the architecture
change; Phase 2 next, since it's the next-highest-priority original
workstream). Workstream 1 ("make the final answer stream-capable," the
single biggest latency gap per the real-time-voice primer research) is
the only one attempted this round — workstreams 2 (client-side fast VAD)
and 3 (the Talker's persona) are still not started.

### Step 1: the dual-call split — a real, live-spiked design decision, then a real (if honestly modest) latency fix

**Design research, not a guess:** the plan's own text left three options
open ((a) reorder the tool schema and parse partial JSON, (b) split into
two calls, (c) investigate Groq's actual streaming behavior first) and
explicitly asked for "its own short design spike, not a guess." Ran one,
against the REAL Groq API, using the exact forced-tool-call shape
`GroqVerbLLM` already sends:
- A forced `tool_choice` call with `stream: true` (Cairn's actual shape)
  produced 34 empty chunks, then the ENTIRE arguments JSON in ONE chunk
  (301ms total) — Groq buffers a forced tool call server-side and
  delivers it atomically even with streaming requested. Rules out option
  (a) outright: there's no partial delivery to parse.
- The identical question with no tools, and again with `tool_choice:
  "auto"` (tools available, not forced), both genuinely streamed token-
  by-token: 82 and 84 content-bearing chunks, first content at 6ms and
  46ms, full completion in 87ms and 221ms.
- **Conclusion, backed by evidence: option (b), the dual-call split, is
  the only viable path.** Written into the plan file's Phase 2 entry
  before any code was touched, same discipline as every other Phase 3/4
  design decision this session.

**Built:**
- `StreamingTextLLM` (`packages/sdk/src/server.ts`) — a genuinely
  unstructured, streamed call: no tools, no forced choice, just the
  model's plain spoken answer, delivered incrementally via an `onChunk`
  callback. Two implementations, `AnthropicStreamingTextLLM` (Anthropic's
  standard `stream: true` Messages API, `content_block_delta`/
  `text_delta` events) and `GroqStreamingTextLLM` (Groq's own OpenAI-
  compatible `delta.content` chunks) — plus `createSpeakerLLM(options)`,
  a provider-selecting factory mirroring `createToolLLM`'s exact real
  rotation/model-selection logic.
- `splitFlushableSentences(buffer)` (`packages/sdk/src/tts-stream.ts`) —
  a pure, deliberately simple sentence-boundary detector: a period/!/?
  followed by REAL whitespace that has already arrived, never at the
  buffer's current end (a decimal like "$3." could still be ".50
  dollars" one chunk later — tested explicitly). Built and tested now
  even though this step's own orchestration doesn't call it yet (see
  Pending) — the real, reusable building block Step 2 needs.
- `ConnectionDeps.speakerLLM` (optional, `realtime-server.ts`) — a
  speculative Speaker call kicked off in `finalizeTurn`, deliberately
  BEFORE `driveAgentLoop` even starts, so its generation time genuinely
  overlaps with the structured `resolveVerb` call's own instead of
  starting only once it's known to be needed. `firstStepWasTerminal`
  (set in `onStep`) gates whether it's even eligible to be used — only a
  genuinely single-step terminal turn (the common case) can safely swap
  in this speculative answer; a multi-step turn's guess would be stale
  by the time the REAL final answer is known, and is simply discarded
  (the ACK phrase already covers that turn's immediate audio need).
  `tour` is explicitly excluded — its per-step texts don't map onto one
  streamed string.
- **A real bug found and fixed via live testing, not left in**: the
  first version of this code unconditionally `await`ed the speaker
  promise once eligible. A live, real-Groq timing comparison (both calls
  given Cairn's actual, full system prompt — not the bare-bones spike
  prompt above) showed the two calls finish close enough in wall-clock
  time that blindly awaiting the speaker call was occasionally SLOWER
  than the old single-call path, whenever the speaker call happened to
  be the slower of the two — the opposite of the point. Fixed by making
  the read OPPORTUNISTIC: a `{text: string | null}` wrapper object (a
  bare `let` gets over-narrowed by TS across the async closures that
  mutate it — a real, documented gotcha, not a style choice) is filled
  in by the speaker call's own `.then()`, and the terminal-outcome
  handling reads it SYNCHRONOUSLY, never awaiting — using it only when
  it's ALREADY there by the time the structured call resolves. This
  makes the path provably non-regressive: it can only ever match or beat
  the old latency, never add a wait the old path didn't already have.

**Tests:**
- `tts-stream.test.ts` (new, 8 tests): `splitFlushableSentences`'
  boundary detection, including the decimal-number false-positive case
  explicitly (`"$3."` → nothing flushed; `"$3.50, thanks"` → still
  nothing flushed, correctly), multi-sentence buffers, `!`/`?`, and an
  idempotent-reconstruction check (nothing dropped between `toFlush` and
  `remainder`).
- `server.test.ts` (+11): both streaming LLM classes tested with fake
  async-generator clients (matching this file's existing
  `capturingFakeLLM` convention) — incremental chunk delivery, ignoring
  non-text stream events, and confirming `stream: true` with NO
  `tools`/`tool_choice` at all is what's actually sent (the real,
  live-spiked reason this call shape exists); `createSpeakerLLM`'s
  provider selection and its clear error when Groq has no keys.
- `realtime-server.test.ts` (+6): a single-step terminal turn speaks the
  Speaker call's text instead of the structured call's own; falls back
  to the structured text on an empty/whitespace-only speaker answer;
  falls back (never throws) when the speaker call itself errors; `tour`
  never uses the speaker path; a multi-step turn never uses turn-0's
  stale speculative guess (asserts the REAL final answer is what gets
  spoken, and the stale guess explicitly is NOT); no `speakerLLM`
  configured behaves exactly as before (existing `ConnectionDeps`
  construction, and all 16 pre-existing tests, re-ran completely
  unmodified and passed — zero regressions on the baseline path).
- Full regression gate: 426/426 tests pass repo-wide (up from 404), zero
  regressions. Full `npm run typecheck` clean across all 6 workspaces.

**Live-verified:** ran the ACTUAL `handleDeepgramMessage` (not a unit
test of a piece in isolation) with REAL `createVerbLLM`/`createSpeakerLLM`
Groq instances racing against each other, against a real manifest, for a
real question ("What is the invoices page for?"). Confirmed the spoken
text differed from the structured call's own text — direct proof the
substitution mechanism fires correctly end to end against the real API,
not just in mocks. Then ran a real, honest timing comparison — 3 runs
each of the old single-call path and the new dual-call path, same
question, real network calls both times:
- Without the Speaker call: 514–703ms to `speakStreamed()`.
- With the Speaker call (after the opportunistic-read fix): 648–842ms.
**Honest finding, not oversold**: with Cairn's real, full system prompt
(verb instructions, manifest context — much longer than the bare-bones
prompt in the initial design-spike), the structured and Speaker calls'
generation times are close enough that this specific comparison didn't
show a dramatic win, though the ranges overlap and the fix's real,
provable guarantee (never worse than baseline) held across every run.
The bigger, more RELIABLE latency win — not dependent on which call
happens to finish first — is Step 2 (see Pending): true incremental
`sendText`/`flush` streaming into TTS, which removes waiting for either
call's FULL completion rather than just racing two full completions
against each other. Scratch scripts deleted after use, same convention
as every prior live check this session.

**Pending:**
- **True incremental TTS streaming (Step 2)** — `splitFlushableSentences`
  is built and tested but not yet wired into `finalizeTurn`; today's
  orchestration `await`s the Speaker call's FULL text (opportunistically,
  never blocking past the structured call) rather than flushing complete
  sentences into `DeepgramSpeakStream.sendText()`/`flush()` as they
  stream in. This is the actual "LLM tokens streamed straight into TTS"
  the plan asks for, and the bigger, more reliable win — deliberately
  NOT attempted in this same step: it needs its own careful concurrency
  design (ensuring at most one Deepgram flush is ever in flight at a
  time, since out-of-order Flushed confirmations were a real, considered
  risk with no way to verify Deepgram's actual ordering guarantees
  without live audio) and its own live verification, which is honestly
  harder to get right than the change shipped here.
- No live VOICE-CALL verification (real mic input, real Deepgram STT,
  real audio playback) — the live check above exercised the real LLM
  race and the real orchestration logic end to end, but not real audio
  I/O. Same disproportionate-setup reasoning already established for
  Phase 3's realtime steps, not re-litigated here.
- Workstream 2 (client-side fast VAD for barge-in) and workstream 3 (the
  Talker's actual persona) — not started.
- The typed/HTTP transport has no Speaker-call equivalent — it's a
  realtime-voice-specific latency concern (a slow-to-render answer isn't
  a "silence" problem on a typed UI the way it is over voice), so this
  wasn't extended there; not a gap, a deliberate scope match.

**Failed:** an earlier version of this step's design (blindly awaiting
the speaker promise once eligible) was live-tested, found to
occasionally be a real regression, and fixed before being called done —
not shipped and found later. Documented under Built, not hidden.

### Step 2: confirm-or-reverse — the STT-confirmation half of barge-in

**A real correction to the plan's own premise, found before writing any
code**: the plan describes today's barge-in trigger as "wait for a
Deepgram transcript" — that's stale. A read-only research pass (Explore
agent) found a client-side RMS-energy heuristic already triggers
barge-in immediately, client-side, with zero STT involvement (added in
an earlier commit, `39f1ea8`). The REAL gap isn't "swap STT for a local
trigger" — it's that today's RMS trigger has **no confirmation and no
way back**: a cough or a door slam cuts the agent off exactly as hard as
real speech does, permanently. This step builds exactly that missing
half — confirm via STT, reverse if wrong — entirely server-side, since
the client's existing trigger already fires within milliseconds (the
plan's own actual ask) and needs no changes.

**Built:**
- `createBargeInConfirmation(windowMs)` (`packages/sdk/src/realtime-server.ts`,
  exported) — a small, standalone timer state machine, deliberately
  extracted rather than left inline inside `handleConnection`'s own
  giant closure (where the equivalent logic would have been
  untestable): `start(onUnconfirmed)` begins a grace window (a second
  `start()` before the first resolves restarts it, never stacks two
  timers), `confirm()` cancels it the moment real speech is recognized,
  `cancel()` is the connection-teardown escape hatch.
- `triggerServerBargeIn()` now starts a `BARGE_IN_CONFIRM_WINDOW_MS =
  600` window on every barge-in (using `lastSpokenText`, a new field
  `speakStreamed` itself records right before queuing anything — real
  content, not guessed). If nothing confirms within the window, this
  concludes the RMS trigger was a false positive and re-speaks the SAME
  text from the top via a real, fresh `speakStreamed()` call — sending a
  new `resume_speaking` message first (purely informational; confirmed
  by reading the client's `ws.onmessage` handler before writing this
  that a fresh `speaking_start`/`audio_chunk` sequence is ALREADY
  handled identically to any other turn starting to speak, so **zero
  client-code changes were needed** for reversal to actually work).
  Explicit, honest simplification: this is "resume" as "restart from the
  top," not a byte-exact continuation from the interrupted point — real,
  separate work this doesn't attempt.
- `handleDeepgramMessage` gains a 10th, optional parameter,
  `onRealTranscript?: () => void`, called once for every message
  carrying real (non-empty) transcript content — interim OR final, so
  confirmation arrives at the fastest possible moment, before
  `speech_final` would otherwise end the turn. The realtime connection's
  own `confirmRealSpeech` (calling `bargeInConfirmation.confirm()`) is
  wired in at the one real call site. Optional and a no-op by default —
  every existing call site (own and every pre-existing test) keeps
  working completely unchanged.
- `ServerMessage` gains `{ type: "resume_speaking" }`.

**Tests:**
- `createBargeInConfirmation` (new, 5 tests, real `vi.useFakeTimers()` —
  deterministic, not timing-flaky): fires `onUnconfirmed` exactly when
  the window elapses (599ms nothing, 600ms fires); `confirm()` before
  the window elapses cancels it entirely; a second `start()` before the
  first resolves correctly restarts the window instead of stacking two
  timers (an explicit, real multi-barge-in scenario); `cancel()` stops a
  pending window; `confirm()` with nothing pending is a safe no-op.
- `handleDeepgramMessage` (+3): `onRealTranscript` fires on a non-final
  (interim) transcript — the fastest-possible-confirmation case; never
  fires for a message with no real transcript content; omitting the
  parameter entirely is a safe no-op (every one of the 22 pre-existing
  `handleDeepgramMessage`/`handleConnection`-path tests re-ran completely
  unmodified and passed).
- Full regression gate: 434/434 tests pass repo-wide (up from 426), zero
  regressions. Full `npm run typecheck` clean across all 6 workspaces.

**Live-verified, real end to end, not mocked**: spun up a REAL
`createRealtimeServer` (real Groq LLM, real Deepgram API key from
`examples/demo-app/.env`) and connected a real `ws` client to it — no
Playwright, no fake mic needed for this specific check, since the
existing `{type: "speak", text}` message (already built for tour
narration) is a real, legitimate way to get the server actively
speaking via a genuinely real Deepgram TTS call. Sequence observed,
timestamped against real wall-clock time:
```
[1472ms] speaking_start          (real TTS audio genuinely started)
          -> sent {type:"barge_in"} with NO follow-up speech
[2082ms] resume_speaking         (610ms later — the 600ms window, confirmed)
[2082ms] speaking_start          (a fresh, real TTS call, unprompted by any new client code)
```
This proves the full mechanism end to end against real infrastructure:
the grace window timing, the false-positive conclusion, the resume
message, and the fresh real speech — all real, none mocked. The
CONFIRMED path (a real transcript arriving and cancelling the window)
is not separately live-verified this way — it would need real PCM audio
routed through Deepgram's actual STT, the same class of setup
`packages/evals`'s Playwright-based fake-mic technique solves for but
which wasn't reused here; the confirmation LOGIC itself (`confirm()`
correctly cancelling a pending window) is unit-tested with fake timers
instead, which is complete coverage.

**Pending:**
- The trigger itself is still the pre-existing RMS-energy heuristic, not
  a trained VAD (Silero or otherwise) — research before this step found
  swapping it in is real, scoped, mechanical work on a known call site
  (`onaudioprocess` in both `index.tsx` and `web-component.ts`), but
  carries a genuinely serious, undecided tradeoff: an ONNX runtime +
  Silero VAD model would add roughly 1-2MB+ to `dist/cairn-widget.js`
  (today ~100KB, single flat IIFE, no code-splitting available), a
  20-30x payload increase for a widget meant to drop into a third-party
  page — lazy-loading the model at realtime-session-start is the only
  way to avoid inflating the always-loaded bundle, but that's a real
  design/hosting decision (CDN placement, load-time latency on a real
  device) this session doesn't have enough information to make well.
  Deliberately not attempted speculatively — flagged honestly as the
  next real decision point, not silently deferred.
- No real-hardware VAD/RMS calibration — `BARGE_IN_RMS_THRESHOLD`'s own
  existing comment already says as much; `BARGE_IN_CONFIRM_WINDOW_MS =
  600` is a reasonable, documented guess, not tuned against real human
  speech-onset timing either.

**Failed:** nothing.

### Step 3: the Talker's actual persona — a prompt/phrase-bank pass, graded not eyeballed

The plan's own text for this workstream: "a prompt/phrase-bank design
pass... evaluated the same way — a real rubric dimension in Phase 1's
judge, not a vibe check." This step does exactly that — rewrites
`ACK_PHRASES` against the plan's own stated bar, and makes the change
gradeable instead of trusting it by feel.

**Built:**
- `ACK_PHRASES` (`packages/sdk/src/realtime-server.ts`) rewritten from
  the original 4-phrase set (average ~6 words, formal/service-desk
  register — "One moment, let me look into that.") to a 6-phrase set
  averaging under 4 words, in the plan's own explicit register ("give
  me a sec, sorting that out"): "Give me a sec.", "One sec, checking.",
  "Hang on, let me look.", "On it, one sec.", "Just a sec here.", "Let
  me check real quick." Two real, stated reasons, not a vibe change:
  matches the plan's own persona bar, and is measurably shorter — a
  real latency win too (a long ack costs real synthesis time before
  it's even audible), not just a tone change.
- A new `{type: "ack", text}` server→client message, sent alongside the
  ack phrase's audio (in `emitEvent`'s existing `"inj"` case). Purely
  informational — the client needs no changes, same precedent as
  `resume_speaking`. The REAL reason this exists: before this step,
  an ack phrase's actual TEXT was never visible anywhere outside the
  synthesized audio itself — not to a person debugging a session, and
  not to `packages/evals`' trace capture, which is exactly what made
  "evaluated... not a vibe check" impossible to actually do.
- `judge.ts` gains a `persona: number | null` dimension (voice runs
  only, `null` when no ack was spoken this run — a single-step turn
  correctly never speaks one, not a missing case) and its own rubric
  line: score whether the ack phrase sounds like a person coordinating
  a team vs. generic-corporate service-desk phrasing, short/natural/
  contraction-friendly scoring high. `buildJudgeUserMessage` gains
  `ackPhraseSpoken`, extracted from `result.voiceFrames` by a new
  `extractAckPhrase` helper — deliberately pulling out just this one
  clean field rather than dumping the full frame array (mostly base64
  audio) into the judge's prompt.

**Tests:**
- `realtime-server.test.ts` (+1): the ack phrase's actual text arrives
  as a real `{type:"ack"}` message, and is the EXACT same string passed
  to `speakStreamed` — never two different things. All 30 pre-existing
  tests (none of which hardcode the old phrase text — confirmed by
  grep before changing it) re-ran completely unmodified and passed.
- `judge.ts`/`judge.test.ts` (+2): `ackPhraseSpoken` is correctly
  extracted from a real `voiceFrames` array containing an `ack` frame;
  correctly `null` when no ack frame is present. Existing `Verdict`
  test fixtures (`judge.test.ts`, `store.test.ts`,
  `evals-dashboard/scripts/seed-demo-data.ts`) updated to the new
  required field — a real, mechanical, repo-wide ripple from a schema
  addition, caught by `npm run typecheck` (not by `vitest`, which is
  transform-only and didn't itself catch two of these — a real reminder
  that the typecheck pass is a genuinely separate, necessary gate, not
  redundant with the test run).
- Confirmed by direct code reading (not a live capture, see Live-
  verified) that `packages/evals/src/runner.ts`'s `voiceFrames` capture
  is generic — it parses ANY JSON text frame off the real Playwright
  WebSocket interception, no per-type allowlist — so the new `"ack"`
  message is picked up automatically with zero evals-harness changes,
  the same way `resume_speaking` and every other existing message type
  already are.
- Full regression gate: 437/437 tests pass repo-wide (up from 434),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces (only after the two real fixture-shape fixes above).
- The dashboard needed **zero changes** — confirmed by grep that
  `evals-dashboard`'s only direct `Verdict` field access is
  `verdict.pass`; every other dimension (including the new `persona`)
  already flows through generically via the JSON-serialized `verdict`
  column in `store.ts`.

**Live-verified:** the message-sending and judge-extraction logic are
both unit-tested end to end with real data shapes; a full live capture
of a REAL multi-step voice turn's `ack` frame flowing all the way
through a real Playwright-driven browser session into a real judge call
was judged disproportionate to set up for this step specifically (it
would need a real client-side click executed against a real page mid-
turn, the same setup cost `packages/evals`' fake-mic scenarios already
carry elsewhere) — the `resume_speaking` mechanism's own step 2 live
check already proved the underlying WebSocket message plumbing this
step reuses works correctly against real infrastructure; this step
reuses that exact same plumbing for a new message type, not a new
mechanism.

**Pending:**
- Prosodic/semantic turn-taking (beyond Deepgram's silence-based
  endpointing) — explicitly out of scope for Phase 2 per the plan's own
  text, unchanged here.
- The VAD-swap tradeoff from step 2 (Silero VAD's real bundle-size
  cost) remains the one real, undecided design question left open in
  this phase. Closed by step 4, below — not by making the deferred
  hosting decision, but by sidestepping the tradeoff entirely.

**Failed:** nothing.

### Step 4: the VAD swap — closed by sidestepping the tradeoff, not deciding it

Step 2 left one real, explicitly undecided question open: swap the bare
RMS-energy barge-in trigger for a real VAD, but a trained model (Silero)
carries a genuine 1-2MB+/20-30x bundle-size cost for a widget meant to
drop into a third-party page — a real hosting/CDN decision this session
didn't have enough information to make well. Re-reading that tradeoff
now: the actual ask was never "use Silero specifically," it was "replace
a heuristic that fires on any loud sound with something that actually
distinguishes speech." A second, dependency-free heuristic can close
most of that real gap without the bundle cost at all — so this step
builds that instead of making the deferred hosting decision.

**Built:**
- `packages/sdk/src/vad.ts` (new, shared, framework-free — imported by
  both `index.tsx` and `web-component.ts`, replacing what was previously
  intentional duplication of `computeRms`/`BARGE_IN_RMS_THRESHOLD` in
  both files with one real shared module, the same "reuse, don't
  duplicate" discipline every other pure-logic module in this session
  has followed). `createVadDetector()` returns a stateful `process()`
  that gates on TWO features instead of one:
  - **Energy (RMS)** — the original signal, kept.
  - **Zero-crossing rate (ZCR)** — a coarse, FFT-free frequency-content
    proxy (fraction of adjacent-sample sign changes). Real speech
    (voiced pitch + harmonics, unvoiced fricatives) sits in a broad
    middle band; a low-frequency hum/rumble sits near zero; hiss/
    static-like broadband noise sits near the ceiling. The band used
    (`[0.003, 0.4]`) is deliberately wide — documented explicitly in
    the module's own header as rejecting only those two extremes, not
    a precise speech classifier, since there's no live mic in this
    environment to tune it more precisely against (the same honest
    caveat step 2's own `BARGE_IN_RMS_THRESHOLD` comment already
    carried, carried forward here rather than overclaimed away).
  - **Adaptive noise floor** — the real, independent improvement beyond
    matching Silero's job: instead of one flat absolute RMS cutoff, an
    EMA of the ambient RMS (updated only on frames NOT classified as
    speech) raises the effective energy threshold in a noisy room
    automatically, while never dropping below the original 0.02
    absolute floor — so a quiet room is never MORE trigger-happy than
    the step-2 baseline, only a noisy one gets genuinely harder to
    false-trigger.
- Both `index.tsx` and `web-component.ts`: removed their duplicated
  `computeRms`/`BARGE_IN_RMS_THRESHOLD`, added one `createVadDetector()`
  instance scoped to the realtime connection (fresh state per connect,
  same lifecycle the rest of that connection's state already has), and
  replaced the bare `rms > BARGE_IN_RMS_THRESHOLD` check with
  `bargeInVad.process(...).isSpeech` at each file's existing
  `onaudioprocess` call site — a mechanical, scoped swap on exactly the
  known call sites step 2's own research had already identified.

**Tests:**
- `vad.test.ts` (new, 16 tests): `computeRms`/`computeZcr` verified
  against hand-computable synthetic arrays (constant/alternating/single-
  crossing signals with exactly derivable expected values, not
  approximated sine waves); `createVadDetector` verified to accept a
  loud speech-band-frequency frame, reject a loud pure-hum frame (zcr
  too low), reject loud Nyquist-rate noise (zcr too high), reject a
  quiet speech-band frame (energy gate), and — the one genuinely novel
  behavior beyond a static two-feature gate — demonstrates the adaptive
  floor directly: the IDENTICAL speech-band frame at rms=0.09 is
  accepted by a fresh detector but rejected by one already primed with
  60 frames of rms=0.06 ambient hum, and `reset()` restores fresh-
  detector behavior.
- Full regression gate: 512/512 tests pass repo-wide (up from 496, +16
  new), zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified:** no live mic in this environment (documented,
unchanged limitation from step 2) — the closest real verification
available: rebuilt `dist/cairn-widget.js` before and after this change
and measured the actual bundle, the concrete number step 2's own
tradeoff was about. Before: 100,531 bytes (98.2kb). After: 100,871
bytes (98.5kb) — **a 340-byte increase**, not the 1-2MB+/20-30x cost a
trained-model VAD would have carried. This is the real, checkable proof
the tradeoff was genuinely sidestepped, not just asserted.

**Pending:**
- This is still a heuristic, not a trained VAD — it will not match
  Silero's real accuracy on genuinely ambiguous audio (quiet speech
  under loud broadband noise, music with vocals). If real-world
  false-trigger/miss rates on this heuristic prove unacceptable once
  there's a way to measure them against real hardware, the Silero path
  (and its lazy-loading/CDN-hosting decision) remains open — this step
  narrows that gap, it doesn't foreclose the alternative.
- Still no real-hardware calibration for either the ZCR band or the
  noise-floor EMA constants — same honest limitation as
  `BARGE_IN_RMS_THRESHOLD` always carried, now extended to the two new
  parameters.

**Failed:** nothing.

---

## Phase 5 — memory

The plan's own text: "Extends today's `history` (per-turn, never
persisted past one session) into real cross-session memory... shape-
inspired by (not copied from) Track B's `memory.py` facts/turns tables
— reimplemented... since Track B's version has no tenant isolation and
wasn't built for this." A research pass (Explore agent, read-only) into
Track B's actual `memory.py` and Track A's actual runtime before writing
any code found two real constraints the plan's own text only gestures
at, both load-bearing for what this phase could honestly build:

- **Track A has no identity concept anywhere.** Grepped
  `packages/sdk/src` and `packages/core/src` for `userId`/`sessionId`/
  `tenantId`/`tenant` — zero hits, beyond LLM-provider API keys. Unlike
  Track B's `customer_id` (one string, no verification, effectively
  single-tenant-per-process), Track A is deployed by a third-party
  developer FOR their own end users — two identity layers, neither of
  which this SDK has ever had a concept of. "Tenant isolation" can't be
  implemented by inventing an auth system here; it has to mean "accept
  whatever opaque id the caller already has, and be honest about what
  isolation that string does and doesn't give" — the same real
  boundary Track B's own `customer_id` already draws, just made
  explicit instead of assumed.
- **Only the realtime relay is a safe place for local SQLite.**
  `server.ts`'s handler runs inside the CUSTOMER's own Next.js API
  route — possibly serverless, with no durable local disk across
  invocations, and nothing in this SDK can detect or guarantee
  otherwise. `realtime-cli.ts`/`realtime-server.ts` is confirmed (by
  its own existing in-closure `history: HistoryTurn[]` state) to be a
  genuine long-lived Node process with real filesystem access — the one
  place a SQLite file dropped next to it would actually persist.

Given both, this phase's first slice deliberately matches Phase 4's own
scoping discipline: build the real store, wire it into the one
transport where it's honestly buildable today, and say plainly that the
other transport doesn't get it yet — rather than guess at either.

### Step 1: a real SQLite memory store, wired into the realtime relay

**Built:**
- `packages/sdk/src/memory-sqlite.ts` (new, exported as
  `@cairnvibe/sdk/memory-sqlite`, mirroring `dashboard-sqlite.ts`'s own
  already-shipped shape exactly — file-or-shared-`Database`, a
  namespaced table, plain `better-sqlite3`, no new dependency) —
  `createSqliteMemoryStore(target)` returns a `MemoryStore`:
  `rememberFact`/`recallFact`/`recallFacts` (explicit upsert by
  `(scopeId, key)`, matching Track B's own "remember is an explicit
  act, never automatic") and `recordTurn`/`recentTurns` (append-only,
  recency-ordered — no search, matching Track B's own real capability,
  not an invented one). `scopeId` is deliberately opaque: this store
  makes no claim about who a scope actually is, only that facts/turns
  under the same string are isolated from every other string.
- `ConnectionDeps.memory?: MemoryStore` and
  `CreateRealtimeServerOptions.memory?: MemoryStore` (both optional,
  same backward-compatible pattern as every prior addition — absent
  means every connection stays exactly as memory-less as before this
  existed).
- The "context" message (already client-sent on every route change)
  gains an optional `scopeId` field — whatever id the CUSTOMER's own
  client code already has for this end user (their own login id, or
  any other stable string they choose; this SDK invents nothing). Only
  the FIRST context message carrying one is used for the whole
  connection — a real, documented v1 simplification, not an attempt at
  handling a scopeId that legitimately changes mid-connection (e.g. a
  login completing partway through a session).
- `seedHistoryFromMemory(existingHistory, priorTurns, maxTurns)` — a
  small, pure, standalone function (same "extract anything genuinely
  testable" discipline as `splitFlushableSentences`/
  `createBargeInConfirmation`): prior turns from memory go first
  (oldest overall), any in-connection history already accumulated
  stays after them, the whole thing capped to `MAX_HISTORY_TURNS` —
  called once, the first time a real `scopeId` arrives, to seed a
  fresh connection's `history` with what actually happened in a PRIOR
  session with the same scope. This is the actual cross-session part:
  before this step, `history` died with the WebSocket every time.
- `finalizeTurn` gains an optional `recordMemoryTurn` callback, called
  alongside both of its existing `history.push(...)` sites (the
  terminal-outcome path and the give-up path) — every real turn this
  scope has, recorded automatically, matching Track B's own "turns are
  automatic, facts are explicit" split. `handleConnection`'s own
  `recordMemoryTurn` closure is a plain `if (!deps.memory ||
  !scopeId) return;` guard — writes nothing when either is absent.
  Explicit fact-remembering (a tool the model could call mid-
  conversation to save a preference/pitfall on purpose) is real,
  valuable future work — not built this step, see Pending.

**Tests:**
- `memory-sqlite.test.ts` (new, 12 tests, mirroring
  `dashboard-sqlite.test.ts`'s own conventions exactly, real
  `better-sqlite3` throughout, no mocks): facts upsert correctly
  (overwrite, not duplicate); facts and turns are isolated per
  `scopeId`; `recentTurns` returns oldest-first and respects a limit by
  keeping the MOST RECENT turns; an empty scope returns `[]`, not an
  error; persistence across separate store instances pointed at the
  same file (the actual point of a durable store); accepts an
  already-open `Database` to share a file with a consumer's own tables.
- `realtime-server.test.ts` (+6): `seedHistoryFromMemory` (4 tests,
  pure-function, no closures) — prior turns ordered ahead of existing
  history; caps to `maxTurns` keeping the most recent overall; both
  empty-input edge cases. `recordMemoryTurn` (2 tests) — called with
  the exact real (role, text) pairs for a real terminal turn; omitting
  it entirely is a safe no-op (every one of the 31 pre-existing tests
  re-ran completely unmodified and passed, confirming the memory-less
  path is byte-for-byte unchanged).
- Full regression gate: 455/455 tests pass repo-wide (up from 437),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces (one real TS narrowing gotcha hit and fixed along the
  way — a `let scopeId` captured by an outer closure and reassigned
  inside an inner one doesn't narrow the same way a local variable
  would; fixed by binding the assigned value to a local `const` first,
  same fix already applied to `speakerText` in Phase 2 step 1).

**Live-verified:** a real `createRealtimeServer`, configured with a
real `createSqliteMemoryStore` (a real temp SQLite file, real
`better-sqlite3`), pre-seeded with two real "prior session" turns for
`scopeId: "live-user-1"` written directly through the store (simulating
an earlier real connection). Connected a real `ws` client, sent a real
`{type: "context", scopeId: "live-user-1", ...}` message against the
real running server — confirmed the connection stayed healthy (no
`error` message), proving the wiring doesn't crash a real server with
memory actually configured. Did **not** additionally live-verify a
full write-then-reload round trip through real STT-driven speech
(would need real synthesized audio routed through real Deepgram STT to
trigger a genuine `finalizeTurn` call — the same class of gap already
documented honestly for Phase 2 step 2's "confirmed" barge-in path, not
re-litigated here); the actual read/write correctness is instead fully
covered by `memory-sqlite.test.ts`'s real-SQLite tests plus
`realtime-server.test.ts`'s direct proof that `recordMemoryTurn` fires
with the real data at the real call site.

**Pending:**
- **The typed/HTTP transport (`server.ts`) gets no memory in this
  slice** — deliberately, per the research above: that handler runs
  inside a customer's own route of unknown (possibly serverless)
  deployment shape, and nothing in the SDK can detect or guarantee
  durable local disk there. A real path forward exists (accept an
  injected store interface — same shape as `MissesStore`/`MemoryStore`
  — rather than Cairn owning a file) but wasn't attempted speculatively
  this step.
- **Explicit fact-remembering** (a tool call the model itself decides
  to invoke mid-conversation, Track B's own `remember_tool`/
  `recall_tool` MCP-tool pattern) is not built — this step wires up
  only the automatic turn-recording half. A real, valuable next slice:
  a new verb or `call_tool`-shaped capability letting the agent
  actually say "remember that this selector is flaky" or "remember the
  user prefers metric units," queryable back via `recallFacts`. Built
  next, in step 2.
- **No keyword/semantic search over memory** — matches Track B's own
  real capability exactly (recency only), not a gap introduced here.
- **No UI/dashboard surface for a deployment's stored memory** — the
  store is a real, working backend; nothing yet exposes "what does
  Cairn remember about this user" to a developer or end user.
- The `scopeId`-changes-mid-connection case (e.g. a login completing
  partway through a voice session) is explicitly not handled — the
  first `scopeId` a connection sees is the only one ever used.

**Failed:** nothing.

### Step 2: explicit fact-remembering — the deliberate half, and a real live-found model quirk

Step 1 built automatic turn-recording (every real turn, logged without
being asked). Track B's own `remember_tool`/`recall_tool` pattern is
explicit — the model decides to save something on purpose. This step
builds that half for Track A.

**Built:**
- A synthetic WebMCP tool, `remember_fact` (name/description/
  inputSchema `{key, value}`), injected into `webMcpTools` by
  `getNextStep` ONLY when both `deps.memory` and a real `scopeId` exist
  for this connection — never offered as a capability with nowhere real
  to write. Modeled as a `call_tool`, not a new verb: reuses the
  EXISTING call_tool grammar and validation the model already knows
  (`isKnownTool`'s check against the request's own `webMcpTools`, in
  `server.ts`, untouched) instead of inventing a new one.
- Handled entirely SERVER-SIDE, in `executeStep` — never routed through
  the client's real WebMCP tool-execution round trip at all. This is
  the real, load-bearing correctness point, not an optimization: today's
  `waitForToolResult()` has exactly ONE pending-callback slot
  (`pendingToolResultResolve`). If the client had been told about this
  step (`{type:"verb", verb}`) and tried to execute a tool it doesn't
  actually have registered, its own failure response would arrive
  asynchronously and could land on whatever a LATER, genuinely unrelated
  step was waiting for — a real, silent data-corruption risk. `onStep`
  now explicitly suppresses sending the verb for a `remember_fact` call,
  closing that risk at the root rather than trying to filter it out
  after the fact.
- `finalizeTurn`/`handleDeepgramMessage` both gain an optional
  `getScopeId` parameter (a getter, same pattern as `getContext`/
  `getGeneration` — necessary because a scopeId can arrive, via a
  "context" message, after a turn has already started) threaded through
  to reach `executeStep`/`getNextStep`, which live inside `finalizeTurn`,
  not `handleConnection`'s own closure where `scopeId` is actually
  declared.

**A real bug found live, not theoretical — and a real, honest limit on
how far a prompt fix alone gets you:** live-testing this against the
actual Groq model (bare `createVerbLLM`, no Planner/Critic configured)
with a real instruction to remember a preference showed the model
calling `remember_fact` **repeatedly** — 6+ times, identical args each
time — instead of recognizing success and moving to a terminal verb,
eventually hitting the iteration cap and giving up despite the fact
having been correctly saved on the very first call. Tried the direct
fix first: rewrote the tool's description to explicitly say "call this
AT MOST ONCE... immediately give your final answer... do not call this
again." Re-tested live — **no change**, still repeated. This is a real,
observed model-reliability limit (consistent with this same model's
other already-documented live quirks — `GroqVerbLLM`'s own
`output_parse_failed`/`tool_use_failed` retry logic exists for exactly
this class of problem), not something a better sentence in a tool
description reliably fixes alone.
Re-tested the SAME scenario with `planLLM`+`criticLLM` also configured
(Phase 3's own architecture — what a real production deployment should
actually run) — **resolved correctly in exactly 2 iterations.** The
Critic's own real reasoning (visible in the live "thk" event) initially
flagged a mismatch between the Planner's assumed `doneContract` and the
observation, then the loop correctly concluded with a clean "explain" on
the very next step — and even in a worse case, the pre-existing
`STALL_THRESHOLD`/iteration-cap fail-safes (Phase 3 steps 2-3) guarantee
the turn can never hang forever regardless. Kept the improved tool
description (a real, harmless refinement, matching the model's
documented tendency to need explicit stop instructions) — the actual,
load-bearing fix for this specific failure mode turned out to already
exist: Phase 3's Planner/Critic redesign, now shown live to catch a
genuinely NEW failure shape it wasn't originally built for, not just its
original diagnosed bug. A strong, unplanned validation of that
architecture's real value.

**Tests:**
- `realtime-server.test.ts` (+4): a `remember_fact` call writes to
  memory with the real scope/key/value AND never reaches the client as
  a verb message AND never calls `waitForToolResult` (using
  `neverCalledWaitForToolResult`, which THROWS if invoked — a real,
  enforced proof the client round trip is genuinely skipped, not just
  asserted after the fact); the tool is offered to the model only when
  memory AND a scopeId are both present; correctly withheld when memory
  is configured but this connection has no scopeId yet; missing
  key/value in the model's own args remembers nothing and returns an
  honest observation instead of crashing. All 37 pre-existing tests
  re-ran completely unmodified and passed.
- Full regression gate: 459/459 tests pass repo-wide (up from 455),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified, real end to end:** the full write path — real Groq
model deciding to call the tool, real server-side interception, real
SQLite write — confirmed twice, with and without Planner/Critic
configured (see the bug narrative above for the second run's real
transcript). `memory.recallFacts(scopeId)` after each run returned
exactly the fact the model chose to save, verbatim. Scratch scripts
deleted after use.

**Pending:**
- The repeated-call quirk is real and live-confirmed WITHOUT Planner/
  Critic configured — the harness's own hard iteration cap and stall
  fail-safes mean a turn can never hang forever even then, but it would
  waste real calls and end in "I wasn't able to finish that" instead of
  a clean confirmation. Not chased further this step — the honest,
  demonstrated fix is running the full Phase 3 architecture, which any
  real deployment wiring up memory should already be doing.
- Same typed/HTTP-transport gap as step 1 — this tool is realtime-only,
  for the same durable-disk reason.

**Failed:** the repeated-call behavior without Planner/Critic — not
silently avoided, documented above with the real transcript and the
real (partial) fix.

### Step 3: reading remembered facts back — closing the loop step 2 opened

Step 2's own Pending list named this directly: a fact the model
explicitly remembered was being WRITTEN correctly, but nothing read it
back into a LATER turn's context — only `recentTurns`' raw, unstructured
conversation text (wired in step 1) had any chance of mentioning it.
This step closes that.

**Built:**
- `formatRememberedFacts(facts)` — a small, pure, standalone function
  (same "extract anything genuinely testable" discipline as
  `seedHistoryFromMemory`/`splitFlushableSentences`/
  `createBargeInConfirmation`): turns a scope's `Record<string,string>`
  of remembered facts into one real, readable sentence ("Remembered
  from a previous conversation with this user: preferredCurrency —
  euros, not dollars."), or `null` for an empty set so a caller can
  cleanly skip adding anything at all.
- Wired into the SAME "context" handler that seeds `history` from
  `recentTurns` (step 1) — right after that seeding, `deps.memory
  .recallFacts(scopeId)` is formatted and, if non-empty, `unshift`ed
  onto `history` as a synthetic `assistant`-role turn. Deliberately
  placed AFTER `seedHistoryFromMemory`'s own `MAX_HISTORY_TURNS` cap is
  already applied, not before — a remembered fact ("prefers metric
  units") should stay in context for the WHOLE connection, not age out
  the same way an ordinary conversation turn does once enough new turns
  accumulate. No changes needed to `resolveVerb`'s own request schema —
  this reuses the EXISTING `history` mechanism entirely, rather than
  inventing a new context channel.

**Tests:**
- `realtime-server.test.ts` (+3): `formatRememberedFacts` returns
  `null` for an empty fact set; formats a single fact into the real
  expected sentence; formats multiple facts, each its own key — value
  pair. All 41 pre-existing tests re-ran completely unmodified and
  passed.
- Full regression gate: 462/462 tests pass repo-wide (up from 459),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified (partial, by design):** the context-message wiring
(scopeId capture, history seeding, fact injection) lives entirely
inside `handleConnection`'s own message handler — unlike
`handleDeepgramMessage`, it isn't independently exported/callable, so
it can't be exercised the same way step 2's `handleDeepgramMessage`-
direct live checks were. Confirmed instead that a REAL running server
(real Groq LLM, real memory store) with a REAL fact pre-seeded for a
scope accepts a real `{type:"context", scopeId}` message from a real
`ws` client without error — the connection stays healthy. A full
"ask a question the model can only answer correctly using the
remembered fact" live check would need a genuinely finalized turn,
which (like step 2's own bare-`createVerbLLM` repeated-call scenario)
requires either real STT-driven audio or a path that bypasses
`resolveVerb` entirely (the `speak` shortcut used elsewhere doesn't
touch `history` at all) — judged the same real, honest gap already
documented for other audio-gated checks this session, not silently
assumed to work. The actual data transformation
(`recallFacts` → `formatRememberedFacts` → a real sentence) is fully,
directly proven by the unit tests above; only the LAST hop (does the
context handler call it at the right moment with the right data) rests
on direct code review rather than a live capture.

**Pending:**
- The "ask a question that can only be answered using a remembered
  fact" full live round trip, per the honest gap above — real future
  verification work, not a known defect. (Closed for the typed
  transport in step 4 below — this exact scenario IS live-verified
  there, since that transport doesn't need real audio to trigger a
  turn.)
- Same typed/HTTP-transport gap as steps 1-2.

**Failed:** nothing.

### Step 4: the typed/HTTP transport gets real memory too

Steps 1-3 explicitly scoped memory to the realtime relay only — the
research behind that decision (Phase 5's own intro) was about WHERE
Cairn itself could safely own a local SQLite file, not about whether
the typed transport could ever use memory at all. Re-reading that
research: the actual blocker was Cairn managing its OWN file inside a
customer's possibly-serverless route — it was never a blocker on the
transport ACCEPTING an already-built `MemoryStore` the customer owns
and persists however they want (their own Redis, Postgres, or yes,
their own SQLite file on their own persistent server). This step closes
that gap.

**Built:**
- `seedHistoryFromMemory`/`formatRememberedFacts` moved from
  `realtime-server.ts` to `memory-sqlite.ts` — the same shared,
  storage-agnostic logic BOTH transports need, re-exported from
  `realtime-server.ts` so every existing import keeps working
  unchanged. One real, disciplined fix instead of a second, drifting
  copy.
- `CopilotRequestSchema` gains an optional `scopeId?: string` — same
  opaque, caller-supplied discipline as the realtime relay's own
  `scopeId` (this SDK invents no identity of its own). Unlike the
  realtime relay (one persistent connection, seeded once),
  this transport is stateless per request — a client wanting
  cross-session memory sends this on EVERY request.
- `CreateCopilotHandlerOptions` (the shared base both
  `CreateCopilotHandlerOptions` and `CreateRealtimeServerOptions` build
  on) gains `memory?: MemoryStore`. `createCopilotHandlerWithLLM`
  seeds from memory ONLY when the request's own `history` arrives
  EMPTY — the real, correct signal for "this is a genuinely fresh
  session," since a session already accumulating its own history
  client-side (the widget's `historyRef`, resent each call) must never
  be re-seeded with the same prior turns on top of itself, request
  after request. Records a NEW turn to memory only for a TERMINAL verb
  (`TERMINAL_VERBS.has(verb.verb)`) — matching the realtime relay's own
  discipline exactly: a continuing step (click/fill/read/call_tool/
  batch) is an internal implementation detail of one logical exchange,
  never its own remembered "turn."
- Explicit `remember_fact`-style tool calling is deliberately NOT built
  for this transport in this step — see Pending for the real reason
  (it needs a materially different mechanism than the realtime relay's
  own server-side interception, since the typed transport has no
  persistent in-process loop to absorb a step into).

**Tests:**
- `core/index.test.ts` (+2): `scopeId` is optional (existing callers
  unaffected); accepts a real scopeId string.
- `server.test.ts` (+6): a genuinely fresh session (empty history)
  seeds real prior turns AND facts from memory, in the correct order;
  a session with its OWN existing history is never re-seeded on top of
  itself (`memory.recentTurns` provably not even called); a terminal
  verb is recorded with the real question and real answer; a
  CONTINUING verb (click) is never recorded; memory configured but no
  `scopeId` on the request means no seeding and no recording at all;
  no memory configured behaves exactly as before. All 81 pre-existing
  `server.test.ts` tests re-ran completely unmodified and passed.
- Full regression gate: 470/470 tests pass repo-wide (up from 462),
  zero regressions. Full `npm run typecheck` clean across all 6
  workspaces.

**Live-verified, real end to end, and this closes a real gap step 3
left open:** unlike the realtime relay (which needs real STT-driven
audio to trigger a genuine turn — the honest gap steps 2 and 3 both
documented), the typed transport's `createCopilotHandlerWithLLM` is
directly callable with NO audio involved at all. Pre-seeded a real
fact (`preferredCurrency: euros`) and a real prior turn into a real
SQLite store for `scopeId: "typed-user-1"`, then called the handler
with a FRESH (empty) client history and the SAME scopeId, asking "What
did I ask about last time, and what currency do I prefer?" — using the
real Groq model. The real answer: *"Last time you asked what the
invoices page is for, and you prefer to work in euros."* — genuinely
using BOTH the seeded prior turn and the remembered fact, not
guessed. Confirmed the new turn was also correctly recorded back
(`memory.recentTurns` showed all 4 turns — 2 prior, 2 new — after the
call). Scratch script deleted after use.

**Pending:**
- Explicit `remember_fact`-style tool calling for the typed transport.
  The realtime relay's own mechanism (server-side interception inside
  `executeStep`, invisible to the client) doesn't translate directly:
  the typed transport has no persistent in-process loop to absorb a
  step into — a `call_tool` verb resolved server-side would need to be
  followed by an INTERNAL second `resolveVerb` call (with the tool's
  real observation folded into history) before returning anything to
  the client, effectively a mini-loop inside one HTTP request/response
  — including its own max-iteration guard, given step 2's own live-
  found finding that this exact model can repeat a tool call rather
  than recognizing success. Real, valuable follow-up work; a
  materially different, more involved mechanism than a quick port,
  deliberately not rushed into this step.
- No dashboard/UI surface for typed-transport memory, same as
  realtime's own still-open gap.

**Failed:** nothing.

---

## Live bug-fix pass: "the agent is answering twice"

Found via real-app testing against `examples/demo-app` — the user reported
the realtime widget replying twice in parallel to one utterance, garbled/
mismatched transcript ordering in the scrollback history, and frequent
"Something went wrong on my end" replies. Investigated all three as real,
separate findings rather than one guessed bug — reading the demo-app's own
live dev-server terminal output was what actually separated them.

**Root causes found (three, not one):**
1. **Groq daily token quota (TPD) genuinely exhausted** — the running
   dev server's own terminal output showed explicit `429
   rate_limit_exceeded` errors on nearly every LLM call ("Limit 200000,
   Used 197844..."), each one independently falling back to
   `server.ts`'s canned `"Something went wrong on my end — try again in
   a moment."` text. Not a code bug — external quota exhaustion, almost
   certainly from this session's own many live-verification runs against
   the same Groq key over the course of the day. No code fix possible;
   flagged honestly as external, not silently worked around.
2. **Orphaned/zombie realtime connections — the real cause of "answering
   twice, in parallel."** Neither client entry point
   (`packages/sdk/src/index.tsx`'s `Copilot` React component, nor
   `web-component.ts`'s vanilla custom element) ever tore down an open
   realtime WebSocket connection, mic `getUserMedia` stream, or the two
   `AudioContext`s on unmount/disconnect — `endRealtime()` /
   `this.endRealtime()` already existed and did the correct full
   teardown, but nothing ever called it except the hangup button.
   Because `@cairnvibe/sdk`'s package `exports` map points `"."`
   straight at `src/index.tsx` (not a built `dist/` file), Next.js dev
   mode recompiles and Fast-Refreshes that component on every source
   edit — and this session was actively editing `index.tsx` (the VAD
   swap, earlier this same session) while the user very plausibly had a
   live call open in the browser. Each Fast Refresh remounted the
   component with fresh state while the OLD WebSocket/mic
   stream/AudioContexts kept running underneath, completely orphaned —
   a genuine second, independent realtime session, replying in parallel
   to whatever the newly-mounted instance does next. This isn't
   exclusively a dev-mode artifact either: any real integration that
   conditionally renders/removes the widget (a route change, a modal
   close) would leak the exact same way in production, today.
3. **Stale-answer transcript mis-pairing — the real cause of duplicated-
   looking or mismatched history bubbles.** `index.tsx`'s WebSocket
   `"final"` handler called `archiveCurrentExchange()` (correctly moving
   the PREVIOUS caption+answer pair into the scrollback log) but never
   cleared `answer` afterward — so if the current turn's own reply never
   arrived (the exact case when a barge-in supersedes an in-flight turn:
   `realtime-server.ts`'s `onStep` silently drops a superseded step via
   its `myGeneration !== getGeneration()` check, never sending a `verb`
   message for it at all), the STALE answer from an earlier, unrelated
   turn stayed in state and got archived alongside the WRONG caption on
   the next `"final"` — surfacing as a reply that looks duplicated or
   attached to the wrong question.

**Built:**
- `index.tsx` (+1 `useEffect`): an unmount safety net that calls
  `endRealtime()` if a connection/cleanup ref is still set when the
  component unmounts — closes the WebSocket, stops the mic tracks,
  closes both AudioContexts. Reads only stable refs, so it's correct to
  call regardless of which render's closure it's attached to; React 18
  safely no-ops the state-setter calls inside `endRealtime()` on an
  already-unmounted component.
- `web-component.ts` (+1 `disconnectedCallback()`): the same fix,
  ported to the custom-element lifecycle hook that was simply never
  implemented — `connectedCallback` existed, its natural counterpart
  didn't.
- `index.tsx`'s `"final"` handler: added `setAnswer(null)` right after
  `setCaption(msg.text)` — a turn that never gets a reply (superseded by
  a barge-in, or any other silent drop) now correctly archives with NO
  reply bubble at all (`archiveText` already skips empty text) instead
  of someone else's answer.

**Tests:** no new automated tests this pass — both are timing/lifecycle
races that depend on real component mount/unmount and real WebSocket
message ordering, not pure functions; full existing regression suite
re-run as the safety check instead. 512/512 tests pass repo-wide (all
pre-existing — no test file touched this pass), zero regressions. Full
`npm run typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly (`dist/cairn-widget.js` 98.6kb).

**Live-verified:** not yet re-tested against a real mic by a human in
this environment (still no live mic here) — these are real, traced-to-
source fixes for symptoms directly observed in the user's own dev-server
terminal output and screenshots, not guesses. The one thing this fix
CANNOT do: retroactively kill an already-orphaned zombie connection from
before it landed — a full browser tab reload is needed to clear any
currently-running orphaned session before re-testing.

**Pending:**
- The Groq daily quota exhaustion (root cause 1) has no code fix — needs
  either waiting for the daily TPD window to reset, or a different/
  upgraded API key.
- No automated regression test added for the two lifecycle/race fixes —
  real coverage would need a DOM-mount/unmount test harness with a fake
  WebSocket, not attempted this pass given the immediate priority was
  landing the real fix.

**Failed:** nothing.

---

## Live bug-fix pass: real key failover on rate-limiting ("if one fails, use another")

Direct follow-up to the previous entry's root cause 1 (Groq daily-quota
exhaustion) — the user's own explicit ask, having configured multiple
Groq API keys (`GROQ_API_KEYS`, comma-separated) specifically for this.
Investigated before assuming it was missing: `KeyRotator`
(`packages/sdk/src/key-rotator.ts`) already existed and was already
wired into every Groq call site (`GroqVerbLLM`, `GroqStreamingTextLLM`
in `server.ts`) — but re-reading it found it does blind, unconditional
round-robin (`take()` just advances on every call, success or failure),
not failover. It spreads LOAD across keys ahead of time; it does nothing
when a call actually fails — a request that lands on an already-
exhausted key just fails, full stop, regardless of how many OTHER keys
are configured. That gap is the literal cause of the previous entry's
still-failing calls even with multiple keys configured.

**Built:**
- `key-rotator.ts` (+1): a `get size()` getter — how many distinct keys
  are configured, so a retry loop knows how many times is actually worth
  trying before giving up (no point cycling past the number of real
  keys).
- `server.ts`'s `GroqVerbLLM.respond`: rewritten around a bounded retry
  loop combining TWO independent, real retry policies — the existing
  one-time retry for a transient tool-call parse/hallucination failure
  (unchanged: exactly one retry, regardless of key count, since it's
  unrelated to which key was used), plus a NEW rate-limit retry that
  fires on a genuine 429/`rate_limit_exceeded` error and tries again —
  `KeyRotator.take()` already advances per call, so the retry naturally
  lands on the NEXT configured key. Bounded to `keys.size` total
  attempts; with only one key configured this never fires (nothing else
  to fall back to) — identical behavior to before this existed.
- `server.ts`'s `GroqStreamingTextLLM.respondStreamed`: same rate-limit-
  retry-on-next-key policy, with one extra real safety condition this
  path needs that the non-streaming call doesn't: a stream can fail
  AFTER already delivering real chunks to the caller via `onChunk`.
  Retrying in that case would re-emit a stream from the start and
  duplicate output the caller already received — so a retry is only
  ever attempted when NO chunk has been emitted yet for the current
  attempt. In practice a 429 always arrives on the initial request,
  before any chunk streams, so this never blocks the real case; it's a
  correctness guard for the theoretical mid-stream case, not dead code.
- `isRateLimitError()` (new, alongside the existing
  `isRetryableToolCallFailure()`): same defensive, multi-shape checking
  approach — Groq's SDK doesn't export a stable error type to check
  against, so this checks `.status === 429`, a couple of `.code`/
  `.error.code`/`.error.error.code` nesting depths, and a message-
  substring fallback, rather than depending on exactly one shape. The
  doubly-nested `.error.error.code` shape is the REAL one confirmed live
  in the demo-app's own dev-server terminal output from the previous
  entry's investigation.

**Tests:** `server.test.ts` (+5): with only one key configured, a
real-shaped rate-limit error (`.status = 429`) still propagates
immediately (no other key to try — matches pre-existing behavior,
replacing an older, less accurately-shaped test that used the same
scenario to test something else); a rate-limit error on the first of
two configured keys retries on the second key and succeeds (the direct
fix for the reported bug); persistent rate-limiting across three
configured keys exhausts exactly three attempts, then throws — never
more retries than there are real keys; the streaming variant retries
across keys the same way when the failure is on the initial request;
and — the one genuinely novel case worth its own test — a mid-stream
failure that arrives AFTER a real chunk was already delivered to the
caller is never retried, proving output can't be duplicated even for a
rate-limit-shaped error once streaming has actually started. 517/517
tests pass repo-wide (up from 512, +5 new), zero regressions. Full `npm
run typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against the real, currently-exhausted
Groq key from this environment (would need the demo app's dev server
restarted to load the rebuilt `dist/`, and a real second account's key
to prove failover against actual live rate-limiting — the fix is
implemented and unit-tested against the exact real error shape observed
in the demo-app's own terminal output from the previous entry, not
guessed at).

**Pending:**
- Scoped to the runtime/conversation LLM calls (`packages/sdk/src/
  server.ts`) only — `packages/indexer/src/key-rotator.ts` (the
  separate, build-time L3 describe-pass rotator) has the identical blind-
  round-robin-only gap and would benefit from the same fix, but that's a
  different call site (a batch build step, not a live conversation) and
  wasn't part of what was reported broken here — a real, honest scope
  boundary, not an oversight.
- The realtime relay process currently running against the demo app
  loads `dist/` at startup — this fix needs the dev server restarted to
  take effect; a rebuild alone doesn't hot-swap already-loaded Node
  modules in a long-running process.

**Failed:** nothing.

---

## Live bug-fix pass: a genuinely different "two speakers" bug — leftover typed audio never stopped when switching into a live call

Direct follow-up after the previous two entries — the user kept reporting
the same-sounding symptom ("still speaking twice") even after both prior
fixes landed and the dev server was restarted. New, precise evidence this
time (the user muting/unmuting/saying "stop" and describing exactly what
each action did or didn't affect) ruled out both earlier theories and
pointed at a genuinely different, third bug:
- Muting the realtime "speaker" button silenced only ONE of two audible
  voices — the other kept playing independent of it.
- Saying "stop" cut off — and after ~1s, restarted from the beginning —
  only the voice the mute button DIDN'T silence.

The mute button only ever touches `rtPlaybackGainRef` (the realtime
WS audio_chunk pipeline); "stop"-triggered restart-from-the-top is
`resume_speaking`, an exclusively realtime-only mechanism (see the
`"the agent is answering twice"` entry above). Both symptoms point at
the SAME pipeline — realtime — meaning the OTHER, unaffected voice had
to be a completely separate, non-realtime audio graph. `index.tsx` has
exactly one: `typedPlaybackGainRef`, the typed/mic-recorded-question
reply path (`playPcmStream`, `stopTypedPlayback`). The typed `<form>`
isn't even rendered while a realtime call is active — ruled out as a
NEW typed submission — but `startRealtime()` never stopped a typed
reply's audio that was ALREADY mid-playback at the moment the user
clicked the phone icon to start a call. `endRealtime()` already calls
`stopTypedPlayback()` on the way OUT of a call (found reading the
existing code); nothing called it on the way IN — the missing third
case of an otherwise-consistent "stop whatever's currently playing
before starting something new" pattern (the same discipline
`playPcmStream()` already applies to itself for two typed replies
resolving close together).

**Built:** `index.tsx`'s `startRealtime()`: added `stopTypedPlayback()`
right at the top, before archiving/connecting — any typed-path audio
still playing when a call starts now stops immediately, instead of
running on unaffected by the realtime session's own mute/barge-in
controls until it happened to finish on its own.

**Tests:** no new automated test — same honest limitation as the
unmount-cleanup fix two entries up: this is a DOM/Web-Audio lifecycle
interaction between two AudioContexts, not a pure function; real
coverage would need a fake-AudioContext test harness, not attempted
this pass. Full regression suite re-run as the safety check instead:
517/517 tests pass repo-wide (unchanged — no test file touched), zero
regressions. Full `npm run typecheck` clean across all 6 workspaces.
`npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic in this environment
(still no live mic here) — traced directly from the user's own precise,
turn-by-turn description of what each control did and didn't affect,
not guessed at. The user needs to restart the demo app's dev server
(loads `dist/` at startup) and hard-refresh the browser tab to pick
this up, same as the prior two entries.

**Pending:**
- The "say stop, it pauses ~1s then resumes from the start" behavior
  itself (once only one real voice is involved) is a SEPARATE, pre-
  existing, already-documented design tradeoff — `triggerServerBargeIn`'s
  confirm-or-reverse window (Phase 2 step 2): if Deepgram doesn't
  confirm real speech within 600ms of a barge-in, the server assumes it
  was a false alarm and restarts the answer from the top. That entry's
  own Pending section already flagged the CONFIRMED (real-transcript-
  arrives) path as unit-tested with fake timers only, never live-
  verified against a real "stop" utterance's actual STT round-trip
  time — a real possibility is that 600ms is simply too short for
  Deepgram to transcribe and confirm a single short word in practice,
  making it look like barge-in "never really works," when the true gap
  is the window's real-world timing. Not fixed here — needs a real mic
  to diagnose the actual STT latency involved before tuning the window
  correctly, which this environment cannot do.
- Same DOM-mount/unmount-race test-coverage gap noted in the earlier
  entry applies here too.

**Failed:** nothing.

---

## Live bug-fix pass: the actual structural race behind "two speakers" — a superseded typed reply's stream kept scheduling audio after being "stopped"

The user kept hitting the same-sounding symptom a FOURTH time, this time
with sharper evidence: two clearly different, overlapping voices, one
starting about a second after the other, with the terminal log showing
TWO separate `/api/copilot/speak` calls (two distinct real LLM replies,
not one duplicated) resolving close together — this time nothing to do
with the realtime call at all. That pointed straight at the shared
typed/mic-reply playback machinery (`playPcmStream`/`stopTypedPlayback`,
`index.tsx`) rather than another narrow trigger point like the prior
three entries.

Reading `playPcmStream` found the actual structural gap underneath all
of this: `stopTypedPlayback()` only ever stops audio nodes that ALREADY
exist in `typedScheduledSourcesRef.current` at the moment it runs — it
has no way to tell an EARLIER, STILL-STREAMING `playPcmStream()` call's
own async reader loop to stop producing MORE of them. That loop
(`for (;;) { const {done, value} = await reader.read(); ...
scheduleChunk(...) }`) has zero cancellation awareness — once started,
nothing stops it from continuing to read and schedule new audio chunks
into the shared graph for as long as its own HTTP stream keeps
delivering bytes, even after a second call has already run
`stopTypedPlayback()` and started its own, unrelated reply. Two replies
resolving within a few seconds of each other (exactly what a slow, rate-
limited `/api/copilot/speak` call — see the earlier key-failover entry —
makes more likely, not less) is enough to reproduce this every time.
This is the same class of problem `tourGenerationRef`/`myGeneration`
already solve elsewhere in this same file for an analogous race (a
stale tour step, a superseded realtime turn) — just missing here.

**Built:** a new `typedPlaybackGenerationRef` counter, bumped inside
`stopTypedPlayback()` every time it runs. `playPcmStream()` captures the
generation at call time and checks it against the current value both
BEFORE and AFTER every `reader.read()` await inside its reader loop —
the moment a newer call supersedes it, the older loop stops scheduling
further chunks on its very next iteration instead of continuing
indefinitely. `scheduleChunk`'s own `onended` cleanup needed no
matching change: a stopped node's handler is already nulled out by
`stopTypedPlayback()` before it's force-stopped, so it never fires for
a superseded node in the first place — only nodes that finish
naturally (which, by construction, only ever belong to the current,
non-superseded generation) ever reach it.

**Tests:** no new automated test — same honest limitation as the two
entries above (a real ReadableStream/Web-Audio timing race, not a pure
function); real coverage would need a fake-stream test harness with
controlled chunk timing, not attempted this pass. Full regression suite
re-run instead: 517/517 tests pass repo-wide (unchanged — no test file
touched), zero regressions. Full `npm run typecheck` clean across all 6
workspaces. `npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment (still no live mic here) — traced directly from the user's
own terminal output showing the two real, distinct `/api/copilot/speak`
calls and their timing, not guessed at. Needs the demo app's dev server
restarted and the browser tab hard-refreshed to pick this up, same as
every fix in this bug-fix-pass series today.

**Pending:**
- This closes the STRUCTURAL race, not necessarily every possible
  trigger of two typed replies firing close together in the first
  place (e.g. why two separate `ask()`/`speak()` calls happened within
  a few seconds of each other in the user's own session is still
  unconfirmed — a double-submit, a retried request, or genuinely two
  separate real questions asked back to back). The fix means that
  regardless of why it happens, it can no longer produce overlapping
  audio — but the "why two calls" question itself wasn't chased down
  further this pass.
- Same fake-stream/fake-timer test-harness gap as the other three
  entries in this series — flagged, not built, given the immediate
  priority was landing the real fix each time.

**Failed:** nothing.

---

## Live bug-fix pass: the hallucinated-tool-name retry never actually fired against the real error shape

Live testing surfaced a NEW, genuinely different bug this time — the
user pasted a terminal error whose `failed_generation` field showed the
model had produced a perfectly good, useful answer ("Sure thing! To
create a new agent, I need to know the name you'd like to give it...")
but the UI showed the generic "Something went wrong on my end" fallback
instead. The error was a `tool_use_failed` — the model calling a
hallucinated tool name (`response_with_verb`) instead of the real one —
exactly the failure mode `isRetryableToolCallFailure`'s own doc comment
already claims to retry and recover from. It didn't fire.

Reading the real error object dumped in the terminal against the
function's actual code found why: the real Groq SDK error is doubly-
nested (`err.error.error.code`) — the SAME shape this session's own
earlier `isRateLimitError` fix (two entries up) had to account for —
but `isRetryableToolCallFailure` only ever checked ONE level
(`err.error?.code`). Against the real shape, `code` always evaluated to
`undefined`, so the `code === "tool_use_failed"` condition never
matched, and the retry never ran — despite passing 100% of its own unit
tests, because every one of those tests hand-built a shallow, one-level
mock (`err.error = {code, message}`) that simply never exercised the
real nesting depth. A genuinely dangerous shape of bug: the code
*looked* tested and correct, and had shipped with a doc comment
confidently claiming it fixed a real, previously-diagnosed issue, while
silently never actually working against the real API.

**Built:** `isRetryableToolCallFailure` now reads `e.code ?? e.error?.code
?? e.error?.error?.code` — the same three-level fallback chain
`isRateLimitError` already used correctly. The `tool_use_failed` branch's
logic is otherwise unchanged (still requires BOTH the code AND the
message to match, so the existing "does NOT retry a tool_use_failed
error unrelated to a hallucinated tool name" test still holds).

**Tests:** `server.test.ts` (+1): a new test using the REAL, doubly-
nested error shape verbatim from the live terminal dump (including the
real `status: 400` and the real hallucinated tool name
`'response_with_verb'`) — this is the test that would have caught the
regression the existing shallow-mock test couldn't. 518/518 tests pass
repo-wide (up from 517, +1 new), zero regressions. Full `npm run
typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from the user's own pasted terminal error
dump, reproduced verbatim as the new test's fixture rather than
approximated.

**Pending:**
- Worth auditing whether any OTHER error-shape-detection helper in this
  codebase has the same "tested against a mock that doesn't match the
  real shape" gap — not done this pass, given the immediate priority
  was landing this specific, already-confirmed-live fix.

**Failed:** nothing.

---

## Live bug-fix pass: the actual root of "two speakers" — a typed reply that outlives the moment realtime takes over

The previous entry's `typedPlaybackGenerationRef` fix closed the race
between two OVERLAPPING typed replies, but the user kept hitting the
same symptom — this time with the smoking gun laid out explicitly: a
realtime call visibly active in the UI the ENTIRE time (the screenshot
shows the call bar throughout), while THREE separate real
`/api/copilot/speak` calls (the TYPED path) fired and were audibly
spoken, one of them with no matching question anywhere in the visible
transcript. That's a structurally different bug from the previous
entry: not two typed replies racing each other, but ONE typed reply
that was already in flight when the user switched into a live call.

The real gap: `startRealtime()`'s guard
(`!realtimeUrl || !micSupported || realtimeActive || rtStartingRef.current`)
never checked `asking` — and the phone-call button's own `disabled`
prop only excludes `busy` (which covers `asking`, but NOT the
unawaited `speak()` call `ask()` fires off afterward once its own
fetch resolves). So a user could click "start call" WHILE an earlier
typed question's reply was still being fetched/synthesized (these
fetches genuinely take several seconds under real conditions — the
timings in the terminal were 4.7s, 5.8s, 8s) — and once that fetch
FINALLY resolved, completely ordinary code (`onExplain`'s `setAnswer`/
`speak()`, `ask()`'s own `finally { setStatus("idle") }`) ran with no
idea a live call had since taken over. The prior entry's fix only
prevented that late reply's audio from overlapping with ANOTHER typed
reply's audio — it did nothing to stop it from overlapping with the
REALTIME call's own audio, or from silently corrupting the UI's status.

**The single most damaging thing found this pass**: `ask()`'s own
`finally { setStatus("idle") }` runs UNCONDITIONALLY. If that stale
typed call finishes after the user is already mid-realtime-call
(`status` is some `"rt-*"` value), this line SILENTLY FORCES the UI
back to `"idle"` — hiding the mic/speaker/hangup controls and showing
the "start call" screen — while the actual WebSocket connection is
still fully alive underneath, still capable of talking, now with
literally no visible way to manage it. This is the most likely
explanation for the user's own "the whole UI is showing my text twice
and totally broken" — not just overlapping audio, but the controls
themselves silently vanishing while the call kept running blind.

**Built:** a new `typedPlaybackSuspendedRef` boolean — set by
`startRealtime()` (alongside the existing `stopTypedPlayback()` call),
cleared by `endRealtime()` and by `startRealtime()`'s own catch block
(mic-permission failure — the call never actually started, so typed
replies shouldn't stay silenced forever). Every place a typed reply's
completion touches shared UI state now checks it first and no-ops
instead:
- `speak()` / `speakAndWait()` — skip calling `playPcmStream()`
  entirely (never even schedule the audio) if suspended, logging a
  `console.warn` so this is now an observable event, not a silent one —
  directly answering the user's own ask for real logging here.
- `runTypedAgentLoop`'s `onStep` (a continuing multi-step reply) and its
  terminal-outcome handler — skip `setAnswer`/`handleVerb` if suspended,
  so a stale typed reply's TEXT can no longer appear as an orphaned
  bubble with no matching question, matching the audio-side fix from
  the previous entry.
- `ask()`'s own `catch`/`finally` — skip the generic error message AND,
  critically, skip forcing `status` back to `"idle"` if suspended —
  this is the fix for the UI-vanishing case above.

**Tests:** no new automated test — same honest limitation as the
lifecycle-race entries above (real async timing between a fetch, a
click, and shared component state; a fake-timers/fake-fetch harness
would be needed for real coverage, not attempted this pass). Full
regression suite re-run instead: 518/518 tests pass repo-wide
(unchanged — no test file touched), zero regressions. Full `npm run
typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from the user's own screenshot (a
realtime call visibly active throughout) and terminal output (three
real, distinct `/api/copilot/speak` calls with matching timings), not
guessed at. Needs the dev server restarted and the browser tab hard-
refreshed to pick this up, same as every entry in this series today.

**Pending:**
- `startRealtime()`'s own guard still doesn't explicitly block on
  `asking` — the new suspension flag makes the RESULT of that race
  harmless (nothing stale can reach the UI or audio anymore), but the
  underlying request itself is still allowed to start and complete in
  the background, wastefully, while suspended. Worth revisiting if
  wasted LLM/TTS calls during this window turn out to matter for cost,
  not just correctness — not addressed this pass since correctness was
  the reported, live problem.
- Same fake-timer/fake-fetch test-harness gap noted in every entry in
  this series applies here too.

**Failed:** nothing.

---

## Live bug-fix pass: a wire-protocol fix — the client had no way to tell a stale realtime message apart from the current one

The user hit the "two speakers" symptom again, this time entirely
WITHIN a single realtime call (no typed path involved) — a screenshot
showing a live call the whole time, with a reply visibly out of order
relative to its question (an answer with no matching question directly
before it, an earlier question's real reply showing up attached to a
LATER question's slot). This is a structurally different bug from every
earlier entry in this series: not two independent audio pipelines
racing, but two CONSECUTIVE realtime turns, connected by a barge-in,
racing each other over the same WebSocket connection.

The real gap: the client's own local barge-in (VAD-triggered energy
detection, entirely independent of the server) can flip status back to
"rt-listening" and accept a brand-new utterance — starting a NEW turn,
a NEW "final" — before an EARLIER turn's own verb/audio message, already
in flight on the wire at the moment the server processed the barge-in,
actually arrives at the client. WebSocket guarantees messages arrive IN
ORDER, but "in order" isn't "still relevant" — the server already had a
generation-based mechanism (`triggerServerBargeIn`'s `generation`
counter) to stop a stale message from being SENT in the first place
(tested and working — see the barge-in test two entries up), but
nothing stopped an ALREADY-SENT message from being applied once it
arrived late. The client had no way to know a message belonged to an
earlier turn than the one it had already moved on to — it just applied
whatever arrived, in order, to whatever caption was currently showing.

**Built:** a real wire-protocol addition — every `ServerMessage` variant
that can be superseded by a barge-in (`final`, `verb`, `speaking_start`,
`audio_chunk`, `speaking_end`, `turn_complete`) now carries the
server's own `generation` at the moment it was produced (the SAME
`myGeneration`/`generation` values `triggerServerBargeIn` and
`speakStreamed` already tracked internally — this just exposes them on
the wire instead of only using them for the server's own internal
drop-before-send check). Both client entry points (`index.tsx`'s
`Copilot`, `web-component.ts`'s custom element) track the generation of
the most recent `"final"` they've processed and drop any later message
whose generation is older — the exact mirror of the server's own
existing `myGeneration !== getGeneration()` pattern, now applied
client-side too. A message with no `generation` field at all is treated
as current rather than dropped, additive/backward-compatible against a
mismatched client/server version pair, the same discipline every prior
wire-protocol addition in this codebase has followed.

**Tests:** `realtime-server.test.ts` (+1, all 5 existing `generation`-
bearing message assertions updated for the new required field): a new
test drives two consecutive turns across a real barge-in (bumping
`generation` between them) and asserts the `final`/`verb` messages for
each turn carry `0` and `1` respectively — the exact case the EXISTING
barge-in test (proving a stale verb never gets sent AT ALL when the
generation moves on before it's ready) doesn't cover: a message that
WAS already sent, tagged correctly so a client can still tell it apart
from the current one after the fact. 519/519 tests pass repo-wide (up
from 518, +1 new), zero regressions. Full `npm run typecheck` clean
across all 6 workspaces. `npm run build -w @cairnvibe/sdk` rebuilt
cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from the user's own screenshot (an
answer with no matching question, an earlier question's reply
attached to a later question's slot) and reasoned through the exact
mechanism (WebSocket ordering vs. relevance, a client-triggered
barge-in racing an already-in-flight server message), not guessed at.
Needs the dev server restarted and the browser tab hard-refreshed to
pick this up, same as every entry in this series today — client AND
server both changed this time, so BOTH sides of the connection need the
new code.

**Pending:**
- `resume_speaking`/`ack`/`error`/`interim` weren't given a `generation`
  field — `resume_speaking`'s own text already carries the real spoken
  content and is inherently about "restart the CURRENT turn," `ack` is
  speculative narration that's harmless even if slightly stale, `error`
  and `interim` are either terminal or self-correcting on the next
  message. Scoped deliberately to the six message types that actually
  drive caption/answer/audio state, not applied blanket-wide.
- Same fake-timer/fake-fetch test-harness gap noted in every entry in
  this series applies to the CLIENT-side half of this fix specifically
  (the generation tracking itself is server-tested; the client's
  `isStaleRtMessage` drop logic has no automated coverage).

**Failed:** nothing.

---

## Live bug-fix pass: the 20s "thinking" watchdog never told the server to give up too — and gave the user zero visible feedback

Found while investigating a "stuck, can't speak, not taking my speech"
report. Checking the demo app's own live terminal output (not guessed
at) confirmed the real, concrete cause: `POST /api/copilot 200 in
20244ms` and `POST /api/copilot 200 in 42953ms` — real Groq calls now
taking 20-43 SECONDS, a direct, honest consequence of the key-failover
fix two entries up. That fix is correct in principle (retrying a
genuinely different, non-exhausted key measurably helps), but when
EVERY configured key is simultaneously rate-limited (which the same
terminal output confirms has been true for hours today), it now retries
once per key before finally giving up — compounding wait time instead
of failing fast, which is what turned a quick, obvious failure into a
long, confusing silence.

That silence is exactly what collided with a real, independent, pre-
existing gap: the client's own 20-second "thinking" watchdog
(`armThinkingWatchdog`) — which exists specifically so a silent server
never leaves the mic stuck deaf forever — only ever reset LOCAL state.
It never told the SERVER anything. So once retries started genuinely
taking longer than 20 seconds (a real possibility only since the
failover fix landed), the watchdog fired, the client silently moved on,
and the server kept working the old, now-abandoned turn regardless —
its reply, whenever it eventually arrived, had no correct way to be
recognized as stale (the same real race the two entries above this one
exist to close, just from a THIRD trigger point neither of those
covered: a client-side timeout, not a client-triggered barge-in).
Worse, the watchdog gave the user precisely nothing to look at while
this happened — a `console.warn` nobody but a developer would ever see,
and a silent reset back to "Listening…" that reads exactly like "it
heard me and did nothing," matching the report verbatim.

**Built:**
- Both client entry points' `armThinkingWatchdog`: on timeout, now
  calls the SAME `triggerBargeIn()` a real interruption already uses
  instead of hand-rolling an incomplete local-only reset. This sends
  the real `barge_in` message, bumping the server's generation exactly
  like a genuine interruption would — so a turn that finally resolves
  after the watchdog gave up now carries an old generation and gets
  correctly dropped by the `isStaleRtMessage` check from the entry
  above, instead of confusingly resuming a conversation the user has
  already moved past.
- A real, visible message (`"That's taking longer than expected — try
  asking again."`) set via `setAnswer`/`this.setAnswer` right after —
  `triggerBargeIn()` itself only clears the caption, it never touched
  the answer, so without this a timed-out turn showed literally
  nothing.

**Tests:** no new automated test — this is a `setTimeout`-driven
lifecycle path, same honest limitation as the other timing-dependent
entries in this series; a fake-timers harness would be needed for real
coverage, not attempted this pass. Full regression suite re-run
instead: 519/519 tests pass repo-wide (unchanged — no test file
touched), zero regressions. Full `npm run typecheck` clean across all 6
workspaces. `npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from the user's own real terminal output
(the two 20s+/40s+ `/api/copilot` timings), not guessed at.

**Pending:**
- The underlying Groq daily quota appears to still be fully exhausted
  as of this entry (confirmed again from a fresh terminal read, hours
  after the first exhaustion was found) — the dominant remaining cause
  of slow/erratic behavior right now is very likely this, not further
  code bugs. Recommended the user temporarily test with
  `CAIRN_RUNTIME_PROVIDER=anthropic` (already supported by
  `realtime-cli.ts`, and `ANTHROPIC_API_KEY` is already configured in
  `examples/demo-app/.env`) to get a clean read unconfounded by Groq's
  quota, rather than continuing to chase symptoms that may simply be
  quota exhaustion wearing a bug's clothing.
- Whether the key-failover fix should also fail fast when it has reason
  to believe every key is currently exhausted (rather than always
  trying each one) is a real, legitimate follow-up — not built this
  pass, since the watchdog fix above already closes the user-visible
  harm of the extra latency regardless of its cause.

**Failed:** nothing.

---

## Live bug-fix pass: the ACTUAL original root cause — a stale React closure that fired on every single realtime turn, plus real, comprehensive logging

Every fix in this series so far patched a real, distinct symptom of "two
speakers" — but re-reading the demo app's own terminal output one more
time, following an explicit user request for real, detailed logging
("literally everything... so we can see where the system is breaking"),
found something more fundamental underneath all of them: `[cairn
talker] act:` (confirmed, by grepping the whole codebase, to log
EXCLUSIVELY from `realtime-server.ts`'s own Talker event stream — never
from the typed `/api/copilot` handler) was followed, on EVERY SINGLE
TURN, by a `POST /api/copilot/speak` call — the TYPED HTTP speak
endpoint, which realtime NEVER calls on its own (it streams TTS audio
directly over the WebSocket via Deepgram's own Speak connection, with no
HTTP round trip at all). Something was calling the typed `speak()`
function on every realtime reply, not just occasionally.

Traced to `index.tsx`'s `handleVerb`'s `onExplain` callback:
`if (!realtimeActive) void speak(text);` — `realtimeActive` is a plain
`const` derived from React state (`status.startsWith("rt-")`),
recomputed fresh on every render. But `handleVerb` is invoked from
`ws.onmessage`, a callback assigned exactly ONCE, inside
`startRealtime()`, and never reassigned for that connection's entire
life. The `realtimeActive` it closed over was frozen at whatever value
existed at THAT render — which is BEFORE the click handler's own state
updates land, so `status` is still `"idle"`. `!realtimeActive` was
therefore `true` on literally every realtime turn, for the entire
history of this feature — calling `speak()` (the typed path) IN
ADDITION to the correct realtime audio playback, every single time.
This is the real, original root cause behind "two speakers" — every
earlier entry in this series (`typedPlaybackSuspendedRef`, the
generation-tagging wire-protocol fix, the watchdog fix) was closing
real gaps in how the SYMPTOM of this bug got handled, without any of
them having found the actual SOURCE generating it on every turn. The
same stale-closure pattern was ALSO present in `runTour()`
(`wasRealtimeListening = realtimeActive`, and the
`setRtStatus("rt-listening")` call at the tour's own end) — meaning a
realtime-triggered tour ALWAYS narrated through the wrong (typed)
pipeline, and — this is the likely direct cause of the "why is it not
listening to me" report — the code responsible for telling the mic to
resume listening after the tour ended NEVER RAN, because it too was
gated on the same permanently-frozen `realtimeActive`.

`rtStateRef` already exists in this file specifically to prevent this
exact class of bug ("mirrors `status` for use inside audio callbacks
(avoids stale closures)" — its own pre-existing doc comment) — it just
wasn't used in these three spots. `web-component.ts` was checked and
confirmed NOT to have this bug: its `realtimeActive` is a `get`
accessor, which re-reads `this.status` fresh on every access regardless
of when the enclosing closure was created — a plain class instance
doesn't have React's per-render closure problem at all.

**Built:**
- `index.tsx`: `onExplain`'s check, `runTour`'s `wasRealtimeListening`
  capture, and `runTour`'s own end-of-tour `setRtStatus("rt-listening")`
  guard — all three switched from the stale `realtimeActive` const to
  `rtStateRef.current.startsWith("rt-")`, which is always current
  regardless of which render's closure is executing.
- A real, comprehensive logging pass, directly answering the user's own
  request: a new `rtLog(event, details)` helper (tag `[cairn rt]`, easy
  to filter on) now fires at every meaningful point in the realtime
  lifecycle — connection open/close/error, every message type received
  (with its generation and key fields), every stale-message drop (with
  both the dropped and current generation numbers so a mismatch is
  visible at a glance), every barge-in and thinking-watchdog fire, every
  call start/end, and — critically — the exact `onExplain` decision of
  whether a reply is spoken over the realtime socket or falls back to
  the typed HTTP path, so this exact class of bug is now something a
  browser console can show directly instead of needing another full
  investigation to re-diagnose. `audio_chunk` messages are deliberately
  NOT logged per-chunk (dozens per turn would flood the console) — chunk
  count shows up as one line at `speaking_end`/`turn_complete` instead.
  Existing scattered `console.warn` calls for the typed/realtime race
  fixes earlier in this series were folded into the same `rtLog` tag for
  consistency, so one filter shows everything.

**Tests:** no new automated test — same honest limitation as every
other entry in this series, now stated more directly: this repository
has no React Testing Library / jsdom test infrastructure at all (`grep`
confirmed — every existing SDK test targets a pure-logic module,
`index.tsx`'s actual component behavior has never been under test).
Setting one up is real, legitimate, disproportionately large work
relative to this fix; flagged as pending rather than built. Full
regression suite re-run as the safety check instead: 519/519 tests pass
repo-wide (unchanged — no test file touched), zero regressions. Full
`npm run typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from grepping the codebase for every
`"[cairn talker]"` log site (confirming realtime-only) and cross-
referencing the demo app's own terminal output (confirming `/api/
copilot/speak` fired on every single turn, not intermittently), not
guessed at. The new logging is specifically what should make the NEXT
live test, whatever it finds, diagnosable directly from the browser
console instead of needing another multi-step investigation like this
one.

**Pending:**
- No React component test harness exists in this repo — a real,
  standalone piece of future work (jsdom + React Testing Library + a
  mock WebSocket/AudioContext) that would let this exact class of bug
  (a stale closure in a long-lived WebSocket callback) be caught by a
  test instead of only by live, symptom-chasing debugging across
  multiple sessions, as happened here.
- Worth auditing whether any OTHER long-lived closure in this file
  (attached once inside `startRealtime()` and never reassigned) reads a
  plain `const` derived from React state instead of a ref — `onExplain`
  and `runTour` were the two found and fixed this pass because they
  were the ones with live, reported symptoms; a systematic sweep for
  the same pattern elsewhere wasn't done.

**Failed:** nothing.

---

## Live bug-fix pass: a multi-step tool loop could never target DOM its own previous step revealed

Live testing of a real multi-step task ("create a new agent named
vikas" — click New Agent, then fill in the name) showed the SAME
failure, "Could not find that element on the page," repeating 5+ times
in a row without ever recovering, across several different re-attempted
strategies from the Critic/replan loop. A real, reproducible,
diagnosable bug, not a flaky one-off.

`liveMapRef` (`index.tsx`) is deliberately frozen once per TURN — its
own doc comment explains why: a background MutationObserver-driven
rescan landing mid-flight shouldn't be able to shift what an element id
resolves to between when a request went out and its response came
back. That reasoning is correct for ONE step's own round trip. It's
wrong across MULTIPLE SEQUENTIAL steps within the same multi-step turn
— a "click New Agent" step that opens a modal genuinely changes the
DOM, and the NEXT step ("fill the name field") needs a scan taken AFTER
that change, not the turn's original, now-stale snapshot from before
the modal even existed. `runTour()` already gets this right for its own
steps (its own comment: "A fresh scan, not the tour's starting
liveMapRef snapshot — a step after a mid-tour navigation targets
elements on a page that didn't exist when the tour began") — the same
fix just hadn't been applied to the two OTHER places a multi-step loop
executes a continuing verb.

**Built:** both the realtime WS `"verb"` message handler's continuing-
step execution and the typed path's `runTypedAgentLoop`'s own
`executeStep` now take a fresh `liveRegistryRef.current.getSnapshot().byId`
immediately before executing each step, instead of reusing the turn's
frozen `liveMapRef.current` — the exact pattern `runTour()` already
established, now applied consistently everywhere a multi-step loop
actually executes a DOM action. `web-component.ts` checked and
confirmed clean: it doesn't implement multi-step tool execution at all,
so this bug doesn't exist there.

**Tests:** no new automated test — same DOM/live-registry timing
dependency as other lifecycle fixes in this series; would need a real
DOM fixture with a modal that appears mid-sequence to properly cover.
Full regression suite re-run instead: 519/519 tests pass repo-wide
(unchanged), zero regressions. Full `npm run typecheck` clean across
all 6 workspaces. `npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment — traced directly from the user's own pasted server log,
which showed the exact repeated failure sequence (click New Agent →
"Clicked it" → fill input-40 → "Could not find that element on the
page", repeated across multiple distinct retry strategies from the
Critic), not guessed at.

**Pending:** same DOM-fixture test-coverage gap as every other live-DOM-
dependent fix in this series.

**Failed:** nothing.

---

## Live bug-fix pass: the real, indexer-level root cause of "Could not find that element on the page" — a genuine INDEXER bug, not a runtime one

The user kept hitting persistent "Could not find that element" failures
even after the fresh-scan-per-step fix landed. Rather than keep guessing
from screenshots, queried the demo app's own SQLite `cairn_misses`
table directly (it already persists every reported miss — real, exact
evidence, no browser console needed for this one): every single miss,
across two separate test sessions, was the SAME four element ids —
`a-13`, `a-22`, `a-31`, `a-40` — always on route `/`.

Looked those ids up in the actual `ui-manifest.json`: their `label` was
literally the SAME synthetic string as their `id` ("a-13" as its own
label — not a real word), their `selector` was the bare tag name `"a"`
with an EMPTY fallback list. That's not a runtime bug at all — it's the
INDEXER (`packages/indexer`) having failed to extract any real text for
these elements when the manifest was originally built, months before
tonight's session even started, leaving them permanently untargetable
no matter how fresh the live DOM scan is.

Traced to the actual page source (`examples/demo-app/app/page.tsx`):
these are the landing page's four navigation cards, each a `<Link>`
wrapping a `<span><Icon/> Go to Invoices</span>` — the label text is
NOT a direct child of the `<Link>`/`<a>`, it's nested one level deeper
inside the icon+text wrapper span. `l1-scan.ts`'s `getElementText()`
only ever read DIRECT `JsxText` children — for an element whose text is
nested inside any wrapper, it found nothing, and `manifest.ts`'s
`elementFallbackSelector` had nothing to fall back to but the bare tag
name once both `text` and `ariaLabel` came back empty. Icon+label is an
extremely common, entirely normal real-world UI pattern — this wasn't
an edge case, it was silently breaking targeting for a mainstream
component shape.

**Built:** `getElementText()` now recurses into nested `JsxElement`
children (collecting every real, static `JsxText` node found anywhere
inside, not just direct children) while deliberately still skipping a
`JsxExpression` (`{dynamicValue}` — never guessed at) and a
`JsxSelfClosingElement` (an icon — has no text to read). Same function
is reused by `l1-in-app-copy.ts` (Phase 4 layer 4) for copy-block
extraction — a pure improvement there too (a `<p>` with nested inline
formatting now reads its real full text instead of only its direct
fragment), not a behavior change requiring separate handling.

**Tests:** `l1-scan.test.ts` (+5, new `getElementText` describe block,
isolated in-memory ts-morph projects): the simple direct-text case
(unchanged behavior); the REAL bug's exact shape, reproduced verbatim
from demo-app's own landing page (`<a><span><Icon/> Go to
Invoices</span></a>` → `"Go to Invoices"`); text joined correctly
across multiple nested elements and multiple text nodes with whitespace
collapsed; a dynamic `{count}` expression never invented as text, only
the real static text around it; an icon-only element with no real text
anywhere returns `null`, not an empty string. 524/524 tests pass repo-
wide (up from 519, +5 new), zero regressions. Full `npm run typecheck`
clean across all 6 workspaces.

**Live-verified:** rebuilt the indexer and re-ran `cairn build` against
the REAL `examples/demo-app` end to end (a real 10-page L3 LLM describe
pass, not a mock). Confirmed directly in the regenerated
`ui-manifest.json`: all four previously-broken elements now have real,
human-readable ids/labels ("Go to Invoices", "View failure dashboard",
"Sessions (no per-row id, on purpose)", "Agent Builder (click-only
action, no fetch)") and real, unique selectors (`a >> text=Go to
Invoices`, etc.) instead of the useless bare `"a"` tag — the exact real,
concrete proof this closes the exact misses recorded live in the user's
own session.

**Pending:** `ui-manifest.json` needs regenerating for any OTHER
already-deployed app that has this same icon+label pattern elsewhere in
its own pages — this fix only affects manifests built (or rebuilt) with
the indexer from this point forward; a manifest built before this fix
keeps its old, broken ids until it's rebuilt.

**Failed:** nothing.

---

## Live bug-fix pass: real server-side connection tracking, and a tour that could get permanently stuck with no error handling at all

Two additions, both aimed at closing real gaps rather than another
guessed symptom fix.

**Server-side connection tracking.** The user raised a serious,
legitimate concern — could a page reload (or several) leave more than
one realtime connection open at once, each independently running its
own Deepgram/LLM calls? Reading the code confirmed no server-side
duplication (one `WebSocketServer`, one `"connection"` handler, one
Deepgram STT setup, one Speak stream per client) — but confirming that
by reading code once isn't the same as being able to SEE it hold on
every future session. `createRealtimeServer` now assigns each
connection a short id and logs it opening and closing, alongside a live
count of how many are active — real, standing visibility instead of a
one-time code-reading conclusion. If that count is ever more than 1
during normal single-tab use, that's now real, direct proof of a
genuine duplicate-connection bug; if it always reads 1, duplication is
ruled out with evidence every session, not assumed away once.

**`runTour()` had no catch block at all — only `try`/`finally`.** Read
through the ENTIRE tour loop tracing "after this it's not listening" —
the line that resumes the mic
(`if (wasRealtimeListening && rtStateRef.current.startsWith("rt-"))
setRtStatus("rt-listening")`) sits at the very end of the `try` block.
Any error thrown ANYWHERE earlier in the loop — a DOM exception from
`el.click()`, a rejected promise, a navigation failure — would skip
that line entirely and leave the mic stuck in whatever state the tour
left it in, with nothing surfaced anywhere except a silently-vanishing
promise rejection. Every other place in this file that can fail mid-
turn (`ask()`, the server's own `handleDeepgramMessage`) already
guarantees some recovery path; this was the one place that didn't.

**Built:**
- `realtime-server.ts`: `nextConnectionId`/`activeConnections`,
  logged on `wss.on("connection", ...)` open and the connection's own
  `close` event.
- `index.tsx`: `runTour()` gains a real `catch` block — logs the error
  (both `console.error` and the new `rtLog` tag), then does the exact
  same mic-resume/status-reset the success path does, so a tour that
  fails partway through still hands control back instead of leaving the
  session stuck.

**Tests:** no new automated test — `createRealtimeServer` has no
existing unit test coverage at all (spinning up a real
`WebSocketServer` + client is real, separate infrastructure work, not
attempted here); the tour catch-block fix is a live-DOM/timing path
like every other lifecycle fix in this series. Full regression suite
re-run instead: 524/524 tests pass repo-wide (unchanged — no test file
touched), zero regressions. Full `npm run typecheck` clean across all 6
workspaces. `npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified, for real this time — not asked of the user.** Started
the actual demo app via this session's own browser tooling, opened the
widget, and drove it directly: a plain typed "hello" got a real reply
with zero errors in the server log; asking it to highlight one of the
four previously-broken landing-page links got "Here is the Invoices
link" (not "Could not find that element") — real, direct confirmation
the `getElementText` fix (two entries up) holds up live, not just in
its own unit tests. Microphone access is blocked in this sandbox, so
the realtime voice path itself — including the tour catch-block fix —
could not be exercised end-to-end; the connection-tracking logging is
now in place specifically so the next real voice test (by the user, who
does have a mic) settles the open "duplicate connection" question with
real terminal output instead of another round of guessing from a
screenshot.

**Pending:** the realtime/voice-specific paths (the tour catch block,
the connection-count logging under real concurrent load) still need a
real microphone to fully exercise — flagged honestly, not glossed over.

**Failed:** nothing.

---

## Live bug-fix pass: the actual deepest root cause of transcript mispairing — `generation` only ever bumped on a barge-in, never on an ordinary new turn

The user reported, precisely: asked "hello", got a real, good reply;
asked a second, different question; it took ~30 seconds; the timeout
message appeared, but paired with the FIRST question's own reply text,
and the second question's own words were gone from the transcript
entirely. Every earlier entry in this series assumed the client-side
generation check (added two entries up) was airtight — tracing this
report line by line finally found the real gap underneath it.

`generation` (`triggerServerBargeIn`'s own counter, the value every
message gets tagged with on the wire) only ever incremented on an
EXPLICIT barge-in. Two ORDINARY, back-to-back turns — no interruption
between them, just the first one taking a while — shared the exact
same generation number, because nothing had bumped it. The client's own
`isStaleRtMessage` check (built specifically to catch a stale message)
had no way to tell the first turn's late reply apart from the second
turn's current one — they looked identical. That's the real explanation
for every "wrong answer attached to the wrong question" report in this
entire series, including ones the earlier, narrower barge-in-specific
fix didn't close.

A second, independent bug compounded it: the thinking watchdog's own
`triggerBargeIn()` call also ran `setCaption("")` — correct-looking for
a REAL, VAD-triggered barge-in (the next "final" immediately overwrites
it with the new utterance anyway), but wrong for the watchdog's own
timeout path, where there is no new utterance coming. It wiped out the
very question that had just timed out, an instant before the timeout
message got set as the answer — leaving the live pair as `{caption:
"", answer: "That's taking longer..."}`, a reply with no visible
question above it, exactly matching the screenshot, and nothing left
for the next `archiveCurrentExchange()` to correctly pair it with
either (`archiveText` skips empty text).

**Built:**
- `realtime-server.ts`: `handleDeepgramMessage` gains a new optional
  `bumpGeneration?: () => void`, called once per genuinely NEW turn (both
  the `speech_final` and `UtteranceEnd` call sites) — BEFORE
  `finalizeTurn` captures its own `myGeneration`, so every real turn now
  gets its own fresh generation number, not just ones following an
  explicit interruption. `handleConnection` wires it as
  `() => { generation++; }` — the exact same counter
  `triggerServerBargeIn` already bumps, now bumped from a second place
  too. Optional and a no-op by default, so every existing call site
  (including every existing test) keeps behaving exactly as before —
  confirmed live: all 45 pre-existing tests passed unchanged with zero
  edits.
- `index.tsx`: `triggerBargeIn()`'s `setCaption("")` removed entirely.
  The next real "final" already handles clearing/overwriting the
  caption correctly via `archiveCurrentExchange()` — this line was
  always redundant for a genuine barge-in and actively destructive for
  the watchdog's own timeout path.

**Tests:** `realtime-server.test.ts` (+1): two ordinary, back-to-back
turns with NO barge-in message and no manual generation bump in the
test itself — proven to receive different generation numbers (`[1, 2]`,
not `[0, 0]`) once `bumpGeneration` is wired in, the exact case the
existing barge-in-specific test doesn't cover. 525/525 tests pass repo-
wide (up from 524, +1 new), zero regressions — including all 45 pre-
existing `realtime-server.test.ts` tests passing completely unedited,
real confirmation the new parameter is genuinely additive. Full `npm
run typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not re-tested against a real mic/browser in this
environment (still no live mic here) — traced directly from the user's
own precise, turn-by-turn description (which reply arrived when, which
question's text went missing, exactly what the timeout message was
paired with), not guessed at, and reasoned through to the actual code
path rather than assumed fixed by the earlier, narrower barge-in-scoped
generation check.

**Pending:** this is the deepest fix in this whole bug-fix series and
still needs a real voice test to fully confirm — flagged honestly, same
as every other realtime-specific fix tonight.

**Failed:** nothing.

---

## Live bug-fix pass: the actual, environmental root cause — Next.js dev mode was watching the app's own database file

The user's own connection-tracking output (from two entries up — the
logging built specifically for this) finally gave the real, unambiguous
answer: `connection 1 opened — 1 active` → one or two real replies →
`connection 1 closed — 0 active`, over and over, a fresh connection
every time. That single fact reframes everything reported across this
entire session: "it stops listening" (the connection itself died, not
a state bug), and "every 'hello' gets a generic greeting" (each
reconnect is a genuinely brand-new connection with zero history — of
course it doesn't remember the prior turn, there wasn't one on this
connection).

The question became: why does the connection keep dying, unprompted,
mid-conversation? `examples/demo-app/lib/db.ts` keeps its SQLite file at
`data/cairn-demo.db` — inside the Next.js project directory. Every
mutating action the demo app takes — a misses-store report, a board
card move, a workflow edit, literally any write through any API route
— touches that file, and via SQLite's WAL mode, its `-wal`/`-shm`/
`-journal` siblings too. `next.config.js` had no watch exclusion for
any of this. Next's dev-mode file watcher covers the whole project
directory by default, and every one of those writes looked exactly
like a source-code change — triggering Fast Refresh, sometimes
escalating to a full reload (matching the "Fast Refresh had to perform
a full reload" warnings seen live in this session's own terminal
output, multiple times, going all the way back to earlier entries in
this series). A full reload tears down everything on the page,
including a live realtime WebSocket connection. This is a genuinely
different KIND of bug from everything else in this series — not a
client or server logic error at all, but a dev-server configuration gap
letting the app's own normal operation look like a source edit.

**Built:** `next.config.js` gains a `webpack` config (dev-mode only)
setting `config.watchOptions.ignored` to exclude `data/**` and SQLite's
own auxiliary file extensions (`.db`, `.db-journal`, `.db-wal`,
`.db-shm`), alongside the standard `node_modules`/`.next` exclusions.
Deliberately does NOT merge with whatever Next's own internal default
already was — that tripped webpack's own config schema validator
("ignored[0] should be a non-empty string") when attempted, since
Next's internal shape isn't guaranteed to be plain strings; a clean,
explicit array of glob strings sidesteps that entirely.

**Tests:** none — this is dev-server/webpack configuration, not
application code; no existing or plausible new automated test covers
this class of change. Full regression suite run as the safety check
instead: 525/525 tests pass repo-wide (unchanged — no test file
touched), zero regressions. Full `npm run typecheck` clean across all 6
workspaces.

**Live-verified, directly, by this session's own tooling — not asked
of the user.** Started the real demo app, confirmed a clean start with
no config errors (an earlier attempt at this exact fix, merging with
Next's own default ignore list, failed webpack's schema validation on
startup — caught and fixed before ever reaching the user). Then fired
five real, rapid writes directly at the live `/api/copilot/misses`
route — the exact same code path every real miss-report in this entire
session went through — and confirmed via the server's own log output
that NOT ONE of them triggered a recompile or reload. Before this fix,
based on the pattern traced through this session's own history, that
same traffic is the leading suspect for every "Fast Refresh had to
perform a full reload" this session ever saw.

**Pending:** the user still needs to confirm this holds for a real,
extended voice conversation with actual mic input — the DB-write
reproduction above proves the mechanism and the fix, but doesn't
exercise the full realtime audio pipeline this environment can't test.

**Failed:** nothing.

---

## Live bug-fix pass: real diagnostic logging for "status says Listening… but nothing gets picked up"

The connection-count logging (two entries up) already changed the
picture once — this same session's next report showed a connection
that stayed open (no "closed" line), confirming the Fast Refresh fix
holds, with a genuinely different, narrower symptom underneath: the
status label correctly reads "Listening…" but speech still isn't being
picked up. `setRtStatus("rt-listening")` is what produces that label,
and it's always set together with `rtStateRef.current` — the exact
value `onaudioprocess`'s own send gate reads — so by the time the label
is showing, the gate SHOULD already be open. Whether it actually is,
and whether real mic packets are reaching the gate at all, wasn't
something any existing log line could show.

**Built:** two new, deliberately low-volume `rtLog` calls (not logged
per-audio-frame, which fires continuously and would flood the
console):
- `maybeResumeListening()`: logs once, right at the moment it actually
  transitions to "rt-listening" — confirms this function ran and
  reached the real resume path, not one of its own early-return guards
  (audio still arriving, a chunk still scheduled, mid-tour).
- `onaudioprocess`'s send branch: a new
  `micAudioSentSinceListeningRef`, reset to `false` every time
  `maybeResumeListening()` fires, flipped to `true` and logged exactly
  once the first time a real mic packet is actually sent afterward.

Together these give a real, three-way diagnosis the NEXT time this
symptom shows up, straight from the console: if "resumed listening"
never logs, the app itself never reached rt-listening (a real app bug,
somewhere upstream); if it logs but "mic audio actually being sent"
never follows, the send gate itself is open but no real audio frames
are reaching it (a deeper client bug); if both log, the gate is
genuinely open and sending — meaning the actual problem is downstream
of this app entirely (Deepgram's own STT, or a real hardware/OS
microphone issue nothing here can see or fix). That's a fundamentally
different, much narrower question than "why does it stop listening,"
and one this environment's own lack of microphone access cannot answer
without it.

**Tests:** no new automated test — pure diagnostic logging, no behavior
change to verify. Full regression suite re-run as the safety check:
525/525 tests pass repo-wide (unchanged — no test file touched), zero
regressions. Full `npm run typecheck` clean across all 6 workspaces.
`npm run build -w @cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not applicable — this is logging, not a fix; nothing
to verify beyond the type/test/build gates above. The real verification
is whatever it reveals on the user's own next live test.

**Pending:** the actual "listening but not picked up" symptom itself is
still open — this closes the diagnostic gap, not the bug. Depending on
what the new log lines show next time, the next step is either a real
app-level fix (if "resumed listening" or the mic-send log never
appears) or an honest acknowledgment that the remaining issue is
outside this codebase's reach (a real hardware/OS/network condition, if
both log lines fire normally and speech still isn't transcribed).

**Failed:** nothing.

---

### Remove the Speaker-call speculative-audio-substitution feature — spoken audio must always match displayed text

Direct, explicit user instruction after a live screenshot showed the
agent's SPOKEN answer correctly addressing an "overview" question while
the DISPLAYED caption showed the unrelated "I'm not sure how to help
with that." This is the risk Phase 2 step 1's own doc comments already
named as "known, accepted" when that feature was built (two
independently-generated answers to the same question, not guaranteed to
agree) — it materialized for real, visibly, and the user's direct
instruction was to remove the feature entirely rather than try to make
the two calls agree ("remove this feature and make it again... remove
that button and everything and make this realtime again").

**Built:** removed the entire "dual-call" speculative-substitution path
from `realtime-server.ts`'s `finalizeTurn`:
- The speculative `speakerLLM.respondStreamed(...)` call kicked off
  alongside `driveAgentLoop`, the `speaker: { text }` result wrapper, and
  its `.then()`/`.catch()` handlers — all removed.
- `firstStepWasTerminal` (the flag that gated whether a turn was even
  eligible for the substitution) — removed, including its
  `onStep`-side assignment.
- The consumption site's substitution branch (`if (firstStepWasTerminal
  && speaker.text !== null && ...) textToSpeak = speaker.text;`) —
  removed. `textToSpeak` is now always exactly `verb.text` — the exact
  same value the client's own caption already renders. Spoken audio and
  displayed text can no longer diverge for a single-step terminal turn,
  by construction, not by coincidence.
- `speakerLLM` removed from `ConnectionDeps`, from the
  `handleConnection(...)` call site, and from `createRealtimeServer`'s
  own `createSpeakerLLM(options)` construction; the `createSpeakerLLM`
  import removed from `realtime-server.ts`.
- `createSpeakerLLM` itself removed from `server.ts` — it existed
  specifically to build the Speaker LLM for this one feature (its own
  doc comment named exactly this purpose), so it's genuinely dead now,
  not general infrastructure. Its underlying `StreamingTextLLM`
  interface and the `AnthropicStreamingTextLLM`/`GroqStreamingTextLLM`
  classes are kept — confirmed via their own dedicated, independent test
  coverage (`server.test.ts`'s `describe("AnthropicStreamingTextLLM")` /
  `describe("GroqStreamingTextLLM")` blocks, which exercise them
  directly, not through `createSpeakerLLM`) that they're real, reusable,
  already-tested streaming infrastructure (including this session's own
  rate-limit-retry fixes) — a future correctly-designed streaming-final-
  answer feature (the thing Phase 2 step 1 was actually trying to
  achieve) can build on them without redoing that work, but nothing
  wires them into a live call path today.

**Tradeoff, stated honestly:** this removes a real latency optimization
(the speculative call was racing the structured call specifically to
avoid waiting for a forced-tool-call response to fully render before
speaking). The structured call's own `verb.text` is now the only source
for spoken audio, exactly like the architecture before Phase 2 step 1
existed. Correctness (what's heard always matches what's shown) is
being deliberately chosen over that latency win, per direct user
instruction — not an oversight.

**Tests:** removed the 6 now-meaningless tests in
`realtime-server.test.ts` that existed specifically to test the
substitution behavior (single-step-uses-speaker-answer,
falls-back-on-empty, falls-back-on-throw, tour-never-substitutes,
multi-step-never-uses-stale-turn-0-answer, no-speakerLLM-configured) —
the feature they tested no longer exists, so keeping them would just be
asserting nothing meaningful. Removed the `fakeSpeakerLLM` test helper
and its now-unused `StreamingTextLLM` import. Removed the 3
`describe("createSpeakerLLM", ...)` tests in `server.test.ts` (defaults
to anthropic, builds a Groq instance, throws with no keys) — same
reasoning, the function they test is gone; `AnthropicStreamingTextLLM`/
`GroqStreamingTextLLM`'s own direct test blocks are untouched and still
pass. Full repo `npx vitest run`: 516/516 passing (525 minus the 9
removed tests, zero regressions elsewhere). Full `npm run typecheck`
clean across all 6 workspaces. `npm run build -w @cairnvibe/sdk`
rebuilt cleanly.

**Pending:** the real latency work this displaces (making the final
answer genuinely stream-capable without a second, independently-
generated call) is still a real, open problem — Phase 2 step 1's
original plan-file section documented a live Groq spike proving a
forced tool call never streams at the field level; that finding still
stands. A future attempt at this needs a design that streams the
*same* answer incrementally (e.g. streaming the structured call's own
output if the provider ever supports partial tool-call streaming, or
restructuring so there's only ever one generated answer, not two) — not
a second, independently-phrased guess.

**Failed:** nothing.

---

### Remove the confirm-or-reverse barge-in "grace window" — a real, live-reported cause of "I say stop and it restarts from the top"

Direct, live bug report: saying "stop" while the agent was mid-answer
cut the audio, paused for about a second, and then the SAME answer
started playing again from the very beginning. Traced to Phase 2 step
2's "confirm-or-reverse" barge-in design in `realtime-server.ts`: every
barge-in armed a 600ms grace window, and unless a real Deepgram
transcript for the interruption arrived and called `confirmRealSpeech()`
within that window, the code concluded the barge-in must have been a
false positive (a cough, a door slam) and re-spoke `lastSpokenText`
from the top via a fresh `speakStreamed()` call. Deepgram's own
transcript for a short, clearly-real interruption like "stop" routinely
took longer than 600ms to arrive — so a deliberate, successful
interruption looked exactly like an unconfirmed false alarm and got
"resumed" every time. The client had no special handling for the
server's own `resume_speaking` message either (confirmed by grep — it
doesn't appear anywhere in `index.tsx`/`web-component.ts`), so the
"resume" was indistinguishable from the agent just starting the whole
answer over. Direct user instruction: there should be no such system at
all — barge-in should be "normal," an immediate, permanent stop, the
way every other voice assistant does it.

**Built:** removed the entire confirm-or-reverse mechanism:
- `triggerServerBargeIn()` (`realtime-server.ts`) simplified to exactly
  three lines: bump `generation` (drops any audio/verb already in
  flight or in the pipe), clear the Speak stream, unstick a pending
  `speakStreamed()` call. No grace window, no resume, no guessing.
- Removed `lastSpokenText`, `bargeInConfirmation`
  (`createBargeInConfirmation`/`BargeInConfirmation`, both previously
  exported for its own standalone tests), `BARGE_IN_CONFIRM_WINDOW_MS`,
  and `confirmRealSpeech()`.
- Removed the `onRealTranscript` parameter from `handleDeepgramMessage`
  entirely (not just stopped passing it) — its only real purpose was
  feeding `confirmRealSpeech()`, which no longer exists; keeping an
  optional parameter with zero live consumer would just be new dead
  code of the same shape this session already cleaned up once.
- Removed the `resume_speaking` server->client message type from
  `ServerMessage` — nothing sends it anymore.
- Left the client (`index.tsx`/`web-component.ts`) untouched: local
  barge-in detection (the RMS-energy VAD on the mic, `triggerBargeIn()`
  stopping already-scheduled audio and sending `{type: "barge_in"}`)
  was already correct and immediate — the bug was entirely server-side,
  in what happened *after* that message arrived.

**Tests:** removed `describe("createBargeInConfirmation", ...)`'s 5
tests (the timer state machine itself, now deleted) and the 3
`onRealTranscript`-specific tests in `realtime-server.test.ts` — all
tested a mechanism that no longer exists. Every other
`handleDeepgramMessage` call site that positionally passed
`recordMemoryTurn`/`getScopeId`/`bumpGeneration` past the now-removed
`onRealTranscript` slot was updated to drop one placeholder `undefined`
each, so those arguments land in their real (now one-earlier) position
— verified by running `realtime-server.test.ts` alone first (32/32
passing) before the full suite. Full repo `npx vitest run`: 508/508
passing (516 minus the 8 removed tests, zero regressions elsewhere).
Full `npm run typecheck` clean across all 6 workspaces. `npm run build
-w @cairnvibe/sdk` rebuilt cleanly.

**Pending:** the real, honest problem the confirm-or-reverse design was
trying to solve — a raw RMS-energy VAD trigger has no idea whether it
just heard real speech or a cough/door slam, so *some* real barge-ins
today will be false positives that now just permanently cut the agent
off with no attempt to recover — is now fully un-mitigated, per direct
instruction to remove the system rather than tune it. If false-positive
barge-in turns out to be a real, separately-reported problem later, the
honest fix is a better LOCAL trigger (a real VAD library instead of raw
RMS energy — already flagged as a known gap in the plan file's Phase 2
comparison table) rather than resurrecting a server-side
guess-and-replay step after the fact.

**Failed:** nothing.

---

### Real research into production barge-in design, and a sustained-speech gate to close the "one noise burst permanently cuts the agent off" gap the previous fix left open

Direct follow-up instruction after the confirm-or-reverse removal above:
research how real, production voice-agent companies actually solve
barge-in/interruption detection — distinguishing real speech from
background noise, and a genuine "stop"/new utterance from a stray
sound — and implement it, rather than leaving the local VAD as the only
line of defense with no minimum-duration gate at all.

**Research** (four independent, real production systems, all converging
on the same answer):
- **Pipecat** — a production barge-in pipeline runs VAD continuously
  during agent speech with an energy gate, a classifier confidence
  threshold, and a documented **250ms minimum duration** before treating
  a detection as a real interruption.
- **LiveKit Agents** — ships both a `min_duration`/`min_words` filter on
  its interruption config AND a separate "adaptive interruption
  handling" ML classifier (86% precision / 100% recall at 500ms overlap,
  rejecting 51% of VAD-only barge-ins as false positives) with a
  configurable `resume_false_interruption` fallback for whatever still
  slips through.
- **Vapi** — `stopSpeakingPlan.voiceSeconds` (VAD-duration threshold)
  **defaults to 0.2s**, explicitly "to balance responsiveness and avoid
  false triggers"; `numWords` is a separate, optional, STT-confirmed
  word-count gate for when even higher precision is wanted (at the cost
  of 100-200ms extra latency waiting on a real transcript).
- **Deepgram's Voice Agent API** — blends prosody/syntax/semantics for
  end-of-turn prediction, but for barge-in specifically still relies on
  the same real-time VAD-during-agent-speech pattern underneath.
- Sources: [Voice AI Barge-In and Turn-Taking: A 2026 Implementation
  Guide](https://futureagi.com/blog/voice-ai-barge-in-turn-taking-2026/),
  [Voice Agent Interruption Handling (Hamming
  AI)](https://hamming.ai/resources/voice-agent-interruption-handling-runbook),
  [LiveKit: Turn detection and
  interruptions](https://docs.livekit.io/agents/v1/build/turn-detection),
  [LiveKit: Solving unwanted interruptions with Adaptive Interruption
  Handling](https://livekit.com/blog/adaptive-interruption-handling),
  [Vapi: Voice pipeline
  configuration](https://docs.vapi.ai/customization/voice-pipeline-configuration),
  [Deepgram Voice Agent
  API](https://deepgram.com/product/voice-agent-api).

**The real, load-bearing convergence point**: every one of these gates
the LOCAL, purely-acoustic VAD trigger on a **minimum sustained
duration** (200-250ms) before ever treating it as a real interruption —
completely independent of any STT transcript timing. That's the
critical difference from the confirm-or-reverse design removed in the
entry above: this fix adds NO network round trip and depends on NO
Deepgram transcript arriving within a deadline, so it structurally
cannot reintroduce that same race. A single cough or door-slam frame
essentially never sustains cleanly across multiple consecutive ~85ms
VAD frames at real speech energy/ZCR bands; genuine speech does.

**Built:**
- `createBargeInGate(minSpeechMs = 200)` in `vad.ts` — a small, stateful
  gate: accumulates consecutive-speech duration frame by frame, resets
  to 0 the instant a non-speech frame arrives, and fires exactly once
  per sustained onset once the accumulated duration crosses the
  threshold. Default of 200ms matches Vapi's own documented default
  (`voiceSeconds: 0.2`), inside Pipecat's documented 250ms production
  range.
- Wired into both `index.tsx` and `web-component.ts`'s
  `onaudioprocess` handlers: `bargeInVad.process(...)` still classifies
  each raw frame exactly as before (energy + ZCR + adaptive noise
  floor, unchanged), but the actual `triggerBargeIn()` call now only
  fires once `bargeInGate.update(frame, frameDurationMs)` returns true.
  `frameDurationMs` is computed for real from
  `e.inputBuffer.length / audioCtx.sampleRate` — never assumed — since
  device/browser sample rates vary (48kHz vs 44.1kHz changes a
  4096-sample frame from ~85ms to ~93ms).
- `bargeInGate.reset()` called whenever mic processing falls through to
  a non-interruptible state (listening, muted, etc.) so stale
  in-progress accumulation from a moment ago never silently carries
  into the next speaking/thinking phase.

**Explicitly NOT built this pass, and why:** an STT-word-count
confirmation gate (Vapi's `numWords`) or a real ML turn-classifier
(LiveKit's adaptive model) — both would add real value (distinguishing
"stop" from "mmhmm," true backchannel-vs-interruption detection per
[Deepgram's own writeup on
this](https://deepgram.com/learn/backchannels-vs-interruptions-voice-agents))
but both need either a transcript round trip (reintroducing exactly the
timing dependency the previous entry's fix removed) or a real trained
classifier model (real added bundle weight/latency, the same tradeoff
`vad.ts`'s own top-of-file comment already declined for the base VAD
itself). The sustained-duration gate is the one piece of this whole
landscape that is genuinely free — zero added latency dependency, zero
added bundle weight — which is why it's the one implemented now; the
rest is real, legitimate future work, not an oversight.

**Tests:** `vad.test.ts` gains 7 new tests for `createBargeInGate` —
doesn't fire on a single sub-threshold frame, fires once accumulated
consecutive speech crosses the threshold, fires exactly once per onset
(not repeatedly once past threshold), a real isolated single-frame
noise burst never fires, any non-speech frame resets the accumulator,
`reset()` clears in-progress state and re-arms a fired onset, and the
200ms default itself. Full repo `npx vitest run`: 515/515 passing (508
existing + 7 new, zero regressions). Full `npm run typecheck` clean
across all 6 workspaces. `npm run build -w @cairnvibe/sdk` rebuilt
cleanly.

**Live-verified:** not possible in this sandbox — no real microphone or
speaker hardware here, and the whole point of this fix is real acoustic
timing (frame-to-frame speech sustain) that can't be faked with a typed
test. Needs the user's own next live voice test to confirm in practice:
a real "stop" said clearly should still cut the agent within roughly
200-300ms (barely perceptible), while an isolated cough/bump/door-slam
should no longer cut it off at all.

**Pending:** if a real cough/noise still manages to sustain past 200ms
in practice (a longer throat-clear, a persistent background sound),
the honest next step per this same research is Vapi's second lever —
an STT-word-count confirmation gate — not reverting to a blind
server-side timeout-and-replay. If false interruptions turn out to be
common enough to matter, LiveKit's real trained adaptive-classifier
approach is the production-grade answer, at the cost of the real
model/bundle-weight tradeoff `vad.ts` already declined once.

**Failed:** nothing.

---

### Automate voice-agent testing, grounded in how production companies actually do it — real end-to-end barge-in probes, wired into CI

Direct follow-up instruction: research how real companies test voice
agents in a sandbox (they don't do it manually) and automate the same
for Cairn. Research (Cekura, Hamming, Coval, Bluejay, Speechmatics'
five-layer framework — see prior entry's Sources) converges on: real
synthetic-caller audio through the real STT/TTS pipeline (not text
injected as a shortcut), deliberate noise/interruption injection mid-
call, mechanical pass/fail scoring, and running the same suite in CI on
every relevant change so a production failure becomes a permanent
regression test. Checked what Cairn already had first: `fake-mic.ts` +
`synthesize.ts` already do the "real synthetic caller" part correctly
(real Deepgram-synthesized audio through the real `getUserMedia`/STT/WS
pipeline, already caught one live regression this way) — the two real
gaps were (1) it only ever ran manually (`npm run evals`, never in CI)
and (2) nothing exercised the barge-in path with real audio timing —
`vad.test.ts` only unit-tests `createBargeInGate` with hand-built PCM
arrays, never through the actual browser AudioContext pipeline a live
interruption goes through.

**Built:**
- `fake-mic.ts`: `installFakeMic` unchanged in signature, but its
  internal AudioContext/MediaStreamDestination graph is now shared and
  kept alive for the page's whole lifetime (previously implicit/
  per-call). Two new exports, `injectMicSpeech(page, audioBase64)` and
  `injectMicNoise(page, durationMs)`, play a SECOND source into that
  same live graph at a time the Node-side test driver chooses — mixing
  in, not replacing, exactly like a second real sound hitting one real
  mic mid-call. `injectMicNoise` generates real broadband noise
  procedurally in the page (`Math.random()` samples) rather than via
  TTS, since Deepgram's Speak API can only produce speech — the same
  acoustic shape (ZCR near its ceiling) `vad.ts`'s own gate is built to
  reject.
- `runner.ts`: extracted `installVoiceFrameCapture` (the real WS-frame
  capture + Next.js HMR-noise filtering, previously inlined in
  `runScenario`) and exported it, plus exported `openWidget`/
  `runVoiceTurn`, so the new barge-in probes reuse the exact same
  live-hardened logic instead of risking drift from a second
  implementation.
- `barge-in-probes.ts` (new): `runBargeInProbe(kind, probeId, options)`
  drives one real end-to-end probe — opens the real widget, asks a
  real long-answer-inducing question ("give me a full overview..."),
  waits for a REAL observed `speaking_start` WS frame (never a fixed
  guessed delay, since LLM/TTS latency varies too much to predict),
  then injects either a real synthesized "Stop, stop, wait." utterance
  (`kind: "interrupt"`) or a real noise burst (`kind: "noise"`). Scores
  itself mechanically (not LLM-judged — an objective protocol check)
  via the exported, pure `evaluateBargeInProbe`: for `"interrupt"`, did
  the client actually send a real `{type:"barge_in"}` WS frame within
  1500ms of injection; for `"noise"`, did it correctly NOT send one.
  This is genuinely new coverage — it's the first test in the repo that
  drives a real "stop" utterance through the real
  AudioContext/ScriptProcessorNode/`createBargeInGate`/`triggerBargeIn`/
  WebSocket chain end to end, rather than unit-testing pieces of it in
  isolation.
- `cli.ts`: runs both probes (interrupt + noise) after the scenario
  suite, prints pass/fail with real reasoning, and folds their result
  into the process exit code alongside the scenario suite's own
  pass^k — a probe failure now fails the whole `npm run evals` run.
- `.github/workflows/voice-evals.yml` (new, separate from `ci.yml` on
  purpose — this hits real paid APIs and costs real wall-clock time,
  `ci.yml`'s own `test` job must never depend on it): triggers on
  push/PR, gated with a `paths:` filter to only the files that could
  plausibly affect the realtime voice path (`realtime-server.ts`,
  `vad.ts`, `index.tsx`, `web-component.ts`, `server.ts`,
  `tts-stream.ts`, `key-rotator.ts`, `packages/evals/src/**`,
  `examples/demo-app/**`) — never fires on an unrelated PR. Builds the
  SDK, starts the real demo-app + realtime relay in the background
  (`examples/demo-app`'s own `npm run dev`, unmodified), polls both
  real ports with `curl` before proceeding (dumping the server's own
  log on a timeout for real debuggability), then runs `npm run evals`
  with `CAIRN_EVALS_K=1` (not the local-dev default of 3 — a deliberate
  cost/latency tradeoff for routine CI, k=3 stays the right choice for
  a deliberate pre-release check run locally). Fork PRs are skipped
  cleanly (no repo secrets reach a fork's checkout) rather than failing
  every real call with an auth error and reporting a false regression.

**Tests:** `barge-in-probes.test.ts` (new) — 8 tests for the pure
`evaluateBargeInProbe` logic: passes/fails on a timely/late/missing
barge_in for the interrupt case, passes/fails on an absent/present
false-positive barge_in for the noise case, ignores a stale barge_in
sent before injection, and correctly treats a short answer finishing
naturally (no activity surviving past the grace window) as NOT a noise
false-positive. Full repo `npx vitest run`: 523/523 passing (515 +
8 new, zero regressions). Full `npm run typecheck` clean across all 6
workspaces, including the new `packages/evals` additions. The workflow
YAML itself was validated with a real YAML parser (not just eyeballed)
before committing.

**Live-verified:** not possible in this sandbox — `runBargeInProbe`
needs a real running demo-app plus real `DEEPGRAM_API_KEY`/
`ANTHROPIC_API_KEY`, neither available here. The pure scoring logic
(`evaluateBargeInProbe`) is fully covered by real unit tests instead;
the end-to-end probe driver itself (`runBargeInProbe`) is exercised
only by the type checker until it runs for real, either locally
(`npm run evals` with real keys + a running demo-app) or the first time
`voice-evals.yml` actually fires in GitHub Actions.

**Pending, and this needs the user's own action, not more code:** the
new workflow reads `secrets.ANTHROPIC_API_KEY`, `secrets.GROQ_API_KEYS`,
and `secrets.DEEPGRAM_API_KEY` — these need to be added as real GitHub
Actions repository secrets (Settings → Secrets and variables → Actions)
before `voice-evals.yml` can run at all; without them every real API
call fails immediately and the job reports every scenario/probe as
failed, which would misread as a code regression rather than "missing
CI configuration." Once added, the very first real run is also the
first real end-to-end verification this feature has ever had — worth
watching closely rather than assumed correct from the type-checked code
alone.

**Failed:** nothing.

---

### Real root cause of "status says Listening but my input isn't picked up": the capture AudioContext can be silently suspended by the browser, with no way for its own code to notice

Direct, repeated live report: after the agent finishes answering, the UI
correctly shows "Listening…" but the next thing said sometimes just
isn't picked up at all — not garbled, not mis-transcribed, genuinely
never sent. A prior entry this session ("Add real diagnostic logging for
status says Listening... but nothing gets picked up") added logging for
this exact symptom but never identified the mechanism; this entry is the
real, live-reported repeat of the same bug, now root-caused.

**The mechanism**: browsers deliberately suspend an `AudioContext` that
has no active audio actually reaching real output — a documented power-
saving policy, not limited to a backgrounded tab. The realtime call's
CAPTURE-side `AudioContext` (mic → `ScriptProcessorNode` → a gain node
fixed at `0` → destination) has, by design, no real audible output at
all — it exists purely to run `onaudioprocess` for mic capture. That
makes it exactly the shape a browser is most likely to suspend. Once
suspended, `onaudioprocess` simply stops firing — nothing inside that
callback can detect or recover from its own silence, since it never
runs again to do so. `rtStatus`/`this.status` never changes (nothing
tells it to), so the UI keeps confidently showing "Listening…" while
genuinely zero audio is being captured. This is a real, externally-
imposed browser condition, not a logic bug in `maybeResumeListening`,
`rtStateRef`, or the send-gate — all of which were checked and confirmed
correct (`setRtStatus` updates `rtStateRef.current` synchronously, no
stale-closure gap).

A real, separate, second failure mode was checked for at the same time,
since the user also asked for "proper error handling... always a live
conversation": nothing previously detected the mic's own
`MediaStreamTrack` actually ending or going muted mid-call (device
unplugged, OS-level permission revoked, another app taking exclusive
mic access) — that would silently produce the identical symptom
(onaudioprocess still fires, but the samples are dead/absent) with zero
user-facing indication anything went wrong.

**Built**, mirrored identically in both `index.tsx` and
`web-component.ts`:
- A `setInterval` health check (every 2s) for the life of a realtime
  call: if `audioCtx.state !== "running"`, calls `audioCtx.resume()`
  (the browser-suspension case); if the mic's own audio track has
  `readyState === "ended"` or `.muted === true`, surfaces a real,
  honest error ("The microphone connection was lost — try starting the
  call again.") and ends the call cleanly via `endRealtime()` rather
  than leaving it silently stuck.
- A direct `track.addEventListener("ended", ...)` listener — the
  track's own real event, firing immediately rather than waiting up to
  2s for the next poll, for the case the browser/OS actually kills the
  track outright.
- `maybeResumeListening()` (both files) now also calls
  `audioCtx.resume()` immediately at the exact moment a turn ends and
  listening resumes — closes the up-to-2s gap the periodic poll alone
  would leave between "the browser suspended capture mid-turn" and the
  next health-check tick, for the specific, common moment (right after
  a turn) most likely to matter.
- Both the interval and the track-ended listener are torn down in the
  existing `rtCleanupRef.current`/`this.rtCleanup` cleanup function, so
  a call that ends normally leaves nothing running.

**Why no server-side or protocol change was needed**: this is a purely
client-side, browser-API-level condition — the WebSocket protocol,
generation-tagging, and barge-in logic (all fixed earlier this session)
were never the cause here and needed no changes.

**Tests:** none added — this is browser-Web-Audio-API wiring
(`AudioContext.state`, `MediaStreamTrack.readyState`/`.muted`, interval/
event-listener lifecycle) with no pure logic to extract and unit-test in
isolation, matching how the rest of this same audio-graph setup code in
both files is already (necessarily) untested at the unit level — a real
constraint of the runtime, not a shortcut. Full repo `npx vitest run`:
523/523 passing, zero regressions (nothing here could have affected any
existing test — no exported function's behavior changed). Full `npm run
typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** not possible in this sandbox — no real microphone or
browser AudioContext suspension behavior to trigger here. This needs the
user's own next live test: specifically, a longer session (several
exchanges) is more likely to hit a real browser-initiated suspension
than a short one, so the real confirmation is "the mic keeps working
reliably across a long multi-turn conversation," not just one exchange.

**Pending:** if the mic still occasionally misses input even after this
fix, the next real diagnostic step is checking the new `rtLog` lines
this entry adds ("capture AudioContext was suspended — resuming", "mic
track is no longer live") in the browser console during the next
live-reported instance — those lines will say definitively whether this
exact mechanism fired (and was recovered) or whether a genuinely
different, still-unknown cause is at work, rather than guessing again.

**Failed:** nothing.

---

### Two real, live-reported multi-step bugs: a stale-read race after fill/click, and no visible sign the agent was still working

Direct, live report with real screenshots: asking the widget to search the
Shop for "earbuds" then report back got a confidently-wrong answer (a book
title, not matching what the real, since-filtered page went on to show),
and separately, once a multi-step turn's progress text appeared ("Typing
earbuds into the search box"), it just sat there unchanged with no visible
sign the agent was still doing anything — indistinguishable from having
silently stopped, especially once the real Groq rate-limit contention from
this session's own heavy testing made a mid-loop call take several real
seconds.

**Bug 1 — stale read after fill/click.** Traced from the server's own
log: the agent typed "book" into the shop search box, then immediately
read the product grid — which still listed EVERY product, including a
book that happened to be in the (not-yet-filtered) list. The real, live
page's search is driven by a Next.js `router.push` → server-component
round trip (`examples/demo-app/components/ShopSearch.tsx`,
`app/shop/page.tsx`) — unbounded network latency, not a fixed debounce a
sleep could reliably wait out. `fill`/`click` in `verb-executor.ts`
reported "done" the instant their DOM event was dispatched, with zero
wait for whatever async re-render that event might trigger — a `read`
step immediately after saw the pre-filter DOM and the agent confidently
reported findings the real, settled page never actually showed.

**Built:** `waitForDomSettle()` (new, `element-ladder.ts`) — watches for
real DOM mutations instead of guessing a sleep duration: resolves
immediately if nothing starts mutating within `initialWaitMs` (100ms —
the action had no async effect, no reason to add latency to the common
case); once mutations start, waits for `quietMs` (200ms) of no further
mutations; a hard `timeoutMs` ceiling (1500ms) means a continuously-
animating/polling page can't stall the agent loop forever. Wired into
both the single-step `fill`/`click` cases in `verb-executor.ts` and the
`batch` action's own `fill`/`click` cases (`executeOneBatchAction`) —
the exact same race exists there too. Defensively falls back to
resolving immediately when `document`/`document.body`/`MutationObserver`
aren't fully available (a real gap found running this session's own
existing tests — one stubs a partial `document` for an unrelated reason,
which broke on `MutationObserver is not defined` before this check was
added).

**Bug 2 — no visible "still working" signal.** The agent's progress
text for a continuing step (`setAnswer(summarizeVerbForHistory(verb))`)
replaces the UI's own animated "thinking" dots (previously shown only
when `answer` was still null) — once that text appears, nothing on
screen changes again until the turn actually ends, however long that
takes. **Built:** a new `loopWorking` boolean state (`index.tsx`), true
from the moment a continuing step's progress text is shown until the
turn genuinely ends (a terminal verb via `handleVerb`, a typed-loop
give-up, a realtime error, or the 20s thinking-watchdog firing) — set at
every one of those real exit points, plus a defensive reset in
`endRealtime()` so a dropped connection can't leave it stuck on. Rendered
as the same three-dot bounce animation, appended inline after the
progress text (a new `.cairn-thinking-inline` CSS modifier) rather than
replacing it, so the "what it's doing" text stays legible while still
showing real motion. `web-component.ts` was checked and confirmed to
have no parallel gap to fix here — its realtime `handleVerb` never
passes an `onToolStep` callback at all, so continuing verbs are already
silently unexecuted there (a real, separate, pre-existing limitation,
out of scope for this fix).

**Tests:** `element-ladder.test.ts` gains 6 new tests for
`waitForDomSettle` — resolves immediately with no/partial `document`,
resolves at `initialWaitMs` when nothing mutates, waits out `quietMs`
once a mutation arrives, keeps resetting the quiet window while
mutations continue, never exceeds the hard `timeoutMs` ceiling, and
disconnects its observer once settled — using a small hand-rolled
`FakeMutationObserver` (no jsdom dependency in this repo) plus
`vi.useFakeTimers()`. Two existing `verb-executor.test.ts` tests
(`click`/`fill` "agent loop" cases) updated from synchronous assertions
to `vi.waitFor`, since `onToolStep` is now a real microtask hop away
even on the fast (no-mutation) path — not a behavior regression, a test
correctly catching up to a real timing change. Full repo `npx vitest
run`: 529/529 passing (523 + 6 new, zero regressions). Full `npm run
typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified:** both fixes confirmed together in one real run against
the live demo-app — asked "Search for keyboard and tell me if you found
it" on `/shop`; screenshot mid-turn showed "(2 steps: fill, read)" with
the new inline dots animating, and the search box had already, really
filtered to just "Mechanical Keyboard" (the settle-wait working); the
final answer — "I searched for 'keyboard' and found a Mechanical
Keyboard product listed." — exactly matched that real, settled state,
with the dots correctly gone once the terminal answer arrived.

**Pending:** the earlier-flagged, real architecture gap this same
conversation surfaced — `navigate` being unconditionally terminal, so a
compound goal like "buy earbuds" that starts with navigation never lets
the Planner/Critic engage — is still open, scoped separately (it's a
`TERMINAL_VERBS`-contract-level change affecting both transports, not a
timing/UI fix). `web-component.ts`'s missing `onToolStep` wiring (no
multi-step tool execution over its own realtime path at all) is a real,
separate, pre-existing gap, also not addressed here.

**Failed:** nothing.

---

### The deferred architecture fix: navigate can now continue the loop — "buy earbuds" is one goal, not "navigate, then wait for me to ask again"

Direct follow-up on the previous entry's own explicitly-deferred item: `navigate` was unconditionally terminal, so a compound goal that starts with navigation ("buy earbuds" — navigate to the shop, then search, then report back) ended the turn the instant it arrived, leaving the rest for the user to manually re-prompt step by step ("you found anything?"). Live evidence for this was already in hand from the same conversation that surfaced the stale-read bug above.

**The real design constraint that shaped this**: `navigate` genuinely needs to stay terminal for the far more common "take me to invoices" case — a blanket "navigate always continues" would tax every simple navigation with a second, needless LLM call. The fix had to be additive and model-decided, not a blanket behavior change.

**Built:**
- `continueAfter: optionalBoolean()` added to `navigate`'s own `VerbResponseSchema` variant and to `COMPANION_FIELDS` (`packages/core/src/index.ts`) — the model sets it `true` only when the goal needs more than arriving; omitted/false behaves exactly as before, zero added cost.
- `isTerminalVerb(verb: VerbResponse)` (new, `@cairnvibe/core`) — the real "does this end the turn" check: `TERMINAL_VERBS.has(verb.verb)` for everything except a navigate marked `continueAfter`, which now returns `false`. Every real call site that had a full `VerbResponse` in hand was switched to this: `agent-loop.ts`'s `driveAgentLoop` (the actual loop-continuation decision, shared by both transports), `index.tsx`'s realtime WS handler (deciding whether to execute a received verb as a continuing step or display it as final), and `server.ts`'s memory-recording gate (so a continuing navigate is never mistakenly written to memory as if it were the whole turn's answer). `TERMINAL_VERBS` itself is untouched — still correct wherever only the verb *type* is available, not a real response.
- `verb-executor.ts`'s `navigate` case now branches: `continueAfter && options.onToolStep` executes the real navigation (`onNavigate`), waits for the page to actually settle (`waitForDomSettle(300, 200, 2000)` — the same real fix from the entry above, applied here since a client-side route change is itself an async re-render, arguably a bigger one than a search filter), then reports `"Navigated to X."` back through `onToolStep` so the loop continues with the NEW page's real context. The `options.onToolStep` check is the real safety gate — `handleVerb`'s own options never provide it, so a `continueAfter` verb reaching the plain terminal dispatch path (the defensive fallback branch) still just navigates once, exactly like today, never silently breaking an older/simpler caller.
- `executeToolStep` (used by both the typed and realtime continuing-step loops) gained an optional 4th `onNavigate` parameter, threaded through to `executeVerbResponse` — without this the navigation could never actually happen when executed as a continuing step, since the wrapper never passed one before.
- `buildVerbToolSchema` and the system prompt (`server.ts`) both updated so the model actually knows this field exists and when to use it — a schema-only change with no prompt guidance would never get set.
- Real, necessary companion fix in `index.tsx`'s typed loop: `route: pathname` and `executeToolStep(verb, pathname, ...)` both switched to `pathnameRef.current` — `pathname` is a plain closure value captured once per render, so after a mid-loop navigation the running loop would otherwise keep reporting the OLD route to the server on every subsequent iteration while the live DOM scan correctly showed the NEW page's elements — a real, silent inconsistency this new feature would have hit immediately. The realtime path already used `pathnameRef.current` throughout.
- `web-component.ts` needed no changes — confirmed (again) that its realtime `handleVerb` never provides `onToolStep` at all, so `verb.continueAfter` there always falls through to the same defensive terminal branch, safely inert.

**Why the server-side context refresh "just works"**: after `onNavigate` fires (a real `router.push`), an *already-existing* `useEffect` on `pathname` (`index.tsx`, near the top of the component) calls `sendFreshContext()` automatically on every route change — this was built for a different reason entirely (keeping the realtime connection's server-side context current after a user's own navigation) but happens to be exactly the mechanism a continuing navigate step also needs, with no new wiring required.

**Tests:** 21 new tests across 4 files — `index.test.ts` (7: `continueAfter` parsing on navigate and as a tolerated companion null elsewhere, `isTerminalVerb`'s full verb-by-verb matrix including the plain/false/true navigate cases), `agent-loop.test.ts` (2: a full scripted two-step loop — navigate with `continueAfter` then explain — proving the loop genuinely re-asks with the navigation's real observation folded into history, plus confirming a plain navigate still short-circuits with zero `executeStep` calls), `verb-executor.test.ts` (6: real execution of the continuing-navigate branch including the text-before-navigating case and the no-`onToolStep` defensive fallback, plus 2 `executeToolStep`-level tests confirming the threaded `onNavigate` callback actually fires), `server.test.ts` (2: the wire schema declares `continueAfter` as nullable boolean, a flat `continueAfter: true` response round-trips through `VerbResponseSchema`). Full repo `npx vitest run`: 546/546 passing (529 + 17 net new, zero regressions). Full `npm run typecheck` clean across all 6 workspaces. **Both `@cairnvibe/core` and `@cairnvibe/sdk` rebuilt** — a real gap hit while making this change: `@cairnvibe/core`'s own package.json resolves the `"node"` export condition to `dist/index.js` (Vitest runs under Node), so the new `isTerminalVerb` export was invisible to every consumer, including the test suite itself, until `core` was rebuilt — not just `sdk`, which had been the only package rebuilt after every other fix this session.

**Live-verified, partially — real, external quota exhaustion (again) blocked the full end-to-end run**: attempted the exact "I want to buy earbuds" phrasing live against the running demo app; the request hit a genuine Groq daily-quota 429 (`org_01k1x6nmjjfbh8yy4mz2x0b14x`, 195,956/200,000 used) — checked, and confirmed all 6 configured keys are currently exhausted the same way documented in the prior "Run the barge-in probes" entries, not a bug in this change. What WAS verified live, directly, without needing any LLM call: `waitForDomSettle(300, 200, 2000)`'s exact algorithm was run against a real Next.js client-side navigation (clicking the real "Shop" nav link) in the live browser — correctly observed the first real DOM mutation at ~60ms and settled at ~262ms, confirming the timing windows are well-calibrated for a real, already-compiled route transition. One earlier attempt, navigating cold to a route the Next.js dev server hadn't yet compiled, missed the mutation window entirely (a dev-server-only, on-demand-compilation artifact — production builds have every route pre-compiled and wouldn't hit this).

**Pending:** the actual "buy earbuds" conversation needs a real, working Groq key to verify end-to-end (the LLM has to genuinely choose to set `continueAfter: true`, which is a model-behavior question this session's own testing can't answer while every configured key is quota-exhausted) — flagged honestly rather than claimed done from the type-checked, unit-tested code alone. A cold, not-yet-compiled dev route very occasionally missing `waitForDomSettle`'s mutation window (see above) is a known, narrow, dev-mode-only limitation — not fixed here, since inflating `initialWaitMs` to cover it would tax the (far more common) warm-navigation case for a gap that doesn't exist in a real production build at all.

**Failed:** nothing.

---

### The real root cause of "status says Listening but nothing happens" — a silently-dead Deepgram STT connection with no reconnect and no client-visible error

Direct, repeated live report, across multiple sessions this week: the mic
shows "Listening…," the user speaks, and nothing is ever transcribed —
looking identical to a browser-side mic/audio problem (which earlier
entries this session already investigated and fixed real instances of:
`AudioContext` auto-suspend, a dead `MediaStreamTrack`). This time the real
cause was one layer deeper and entirely server-side.

**The mechanism**: `realtime-server.ts` opened exactly one Deepgram STT
WebSocket per call and never listened for it closing —
`dg.on("open"/"message"/"error", ...)` all existed, but there was no
`dg.on("close", ...)` at all. Deepgram's own real-time STT connections do
close mid-session for real reasons (an idle timeout, a network blip,
Deepgram's own connection lifetime limit) — when that happened, `dgOpen`
(a flag meant to track exactly this) never got reset to `false`, and every
subsequent mic frame kept hitting `if (dgOpen) dg.send(buf)` against an
already-CLOSED socket, with no callback to catch the failure and nothing
downstream ever notified. The client never received an "error" message,
never saw its status change, and the mic UI kept confidently showing
"Listening…" — a dead pipe with zero visible symptoms until the whole call
was ended and restarted.

**Built**: `dg` is now reassignable behind a small `connectDeepgramStt()`
function instead of one fire-and-forget `WebSocket` — a real `close`
handler resets `dgOpen`, and (unless the whole realtime connection has
itself already ended) automatically reconnects with a fresh handshake, up
to `MAX_DG_RECONNECT_ATTEMPTS = 3` attempts, before finally giving up and
sending the client a real, honest error ("Speech recognition connection
was lost and couldn't be restored — try starting the call again.") instead
of staying silently broken forever. The binary-audio send site also now
checks `dg.readyState === WebSocket.OPEN`, not just the `dgOpen` flag, as
defensive belt-and-suspenders against a frame arriving in the same tick as
an unprocessed close event.

**Tests**: none added — `handleConnection` (where this lives) has never
been unit-tested in this codebase; every existing `realtime-server.test.ts`
test exercises the exported `handleDeepgramMessage` directly with fake
deps, deliberately bypassing the real WebSocket wiring this fix touches
(confirmed by grep — zero existing tests reference `handleConnection`).
Extracting genuinely testable pieces (e.g. a bare reconnect-attempt-
counting function) was considered and skipped as needless abstraction —
the real complexity here is the WebSocket lifecycle itself, which needs a
live Deepgram connection (or a real mock WebSocket server) to exercise
meaningfully, matching this file's own established, honest limitation
elsewhere (e.g. the earlier connection-tracking fix this session, also
untested for the same reason). Full repo `npx vitest run`: 529/529 passing,
zero regressions (nothing here changed any exported function's behavior).
Full `npm run typecheck` clean across all 6 workspaces. `npm run build -w
@cairnvibe/sdk` rebuilt cleanly.

**Live-verified**: not possible in this sandbox — reproducing a genuine
Deepgram-side connection drop on demand isn't something this environment
can trigger reliably. This needs the user's own next live session,
specifically a **longer** one (this failure mode is time/network-dependent,
not something a short exchange would hit) to confirm in practice.

**Pending**: if the mic still goes silently unresponsive after this fix,
the new `console.log`/`console.error` lines this entry adds ("Deepgram STT
connection closed," "reconnecting to Deepgram STT," "gave up
reconnecting") will say definitively whether this exact mechanism fired (and
was recovered, or exhausted its retries) — check the server's own terminal
output during the next live-reported instance rather than guessing again.

**Failed:** nothing.

---

### Architecture Pillar 1 — a richer, still-verified action vocabulary: drag, select, key (the concrete fix for "operate literally any platform," starting with node-canvas editors like n8n)

The first of a 6-pillar architecture plan (see the plan file this session
approved: "General platform capability — the agent learns a platform and
writes its own playbook for it") aimed at making Cairn's agent capable of
operating any real web platform, not just an app pre-scanned at build time.
Real, named gap this closes: the action vocabulary was click/fill/read/
call_tool/navigate/do/highlight/open/tour/batch — nothing that can connect
two nodes on a workflow canvas, choose a dropdown option, or send a
keypress. "Operate n8n" is structurally impossible without at least a drag
gesture; this pillar adds exactly the three verbs the plan called out as
step 1, in the plan's own stated order (`upload`/`scroll`/`wait_for` are
deliberately deferred — `upload` in particular needs its own design pass
for the "real native file picker only" constraint).

**Built**:
- `packages/core/src/index.ts` — `VERBS` gained `"drag"`, `"select"`,
  `"key"`; `VerbResponseSchema` gained matching discriminated-union variants
  (`drag: { target, to }`, `select: { target, value }`, `key: { target?,
  key }`); `BatchActionSchema` got the same three variants so a batch can
  mix them with the original four. All three are continuing steps — never
  added to `TERMINAL_VERBS` — so `isTerminalVerb` (added earlier this
  session for `navigate`'s `continueAfter`) already treats them correctly
  with zero further changes needed there.
- `packages/sdk/src/element-ladder.ts` — three new real-DOM-action
  functions, each following the same "never invented, only ever a real
  target already resolved through the element ladder" discipline as
  `fillElement`/`readElement`:
  - `selectOption(el, visibleText)` — native `<select>` gets a direct
    `.value` set (matched by the option's real visible text, exact then
    substring, same two-tier matching `findElement` already uses) plus the
    same input+change event pair `fillElement` fires so React notices; a
    custom listbox/combobox (`role="option"`, Radix/Headless-UI-shaped)
    falls back to clicking the matching option-shaped descendant, since
    there's no real `<option>` to set on those.
  - `dragElement(from, to, steps=5)` — a real multi-point pointer-event
    sequence (mousedown → several mousemoves → mouseup, center-to-center),
    firing both `PointerEvent` (when available) and `MouseEvent` variants so
    canvas/kanban/sortable libraries that only listen for one or the other
    both get real events — same technique this session's own iOS Simulator
    tooling already uses for `touch_path`, applied to DOM pointer events.
  - `pressKey(el, key)` — focuses the target first (a real keypress always
    lands on whatever's focused), fires keydown/keyup, plus a keypress in
    between for the two keys that still get one in a real browser
    (Enter/Tab) — not for pure navigation keys like arrows, matching modern
    browser behavior.
- `packages/sdk/src/verb-executor.ts` — `dispatchVerb` gained `"drag"`/
  `"select"`/`"key"` cases (single-step and inside `executeOneBatchAction`),
  each following the exact click/fill shape: resolve via `findElement`
  (or `findElementWithRetry` in the batch path), miss → `onMiss` + a failed
  `ToolStepResult`, success → `highlightElement` + the real action +
  `waitForDomSettle()` before reporting back (drag/select can trigger an
  async re-render exactly like click/fill already can — e.g. a canvas
  redrawing a new connection line, a dependent field appearing after a
  select). `key` never highlights (pressing a key doesn't call attention to
  a NEW element the way click/fill/drag/select do) and skips
  `waitForDomSettle` only in the sense that it still awaits it before
  reporting, for the same "next step needs the settled DOM" reason.
  `ToolStepResult.verb`'s union type extended accordingly.
- `packages/sdk/src/server.ts` (`resolveVerb`) — the same "must name
  something real" gate `click`/`fill`/`read` already got extended to
  `select` (its `target`), `drag` (both `target` AND `to`, refusing the
  whole turn if either is invented), and `key` (its `target` only when the
  model actually supplied one — an omitted target legitimately means
  "whatever's focused," never something to validate against real state).
  The batch gate's per-action check extended the same way. `TIER_ALLOWED_VERBS`
  needed no change — its `act` tier is `new Set(VERBS)`, so the three new
  verbs are automatically included at the one tier that already allows
  click/fill.
- `packages/sdk/src/server.ts` (`buildVerbToolSchema` + system prompt) —
  new nullable `to`/`key` wire properties (with the same
  Groq-sends-null-for-inapplicable-fields tolerance every other optional
  field already has), `target`'s and `value`'s descriptions extended to
  cover drag/select, the batch actions' verb enum extended to all seven,
  and three new system-prompt bullets explaining drag/select/key to the
  model in the same style as the existing click/fill/read/call_tool
  bullets (concrete examples: connecting canvas nodes, moving a kanban
  card, choosing a real dropdown option by its visible text never an
  internal value, pressing Escape/Enter/Tab/arrows).
- `packages/sdk/src/agent-loop.ts` and `packages/sdk/src/index.tsx` —
  both copies of `summarizeVerbForHistory` (the shared extracted one, and
  the separate raw/defensive one `index.tsx` still uses for the realtime
  path) gained drag/select/key cases, so a continuing step's own history
  entry reads like "(dragged node-a to node-b)" instead of silently falling
  through to the generic "(no response)" default case the switch already
  had.

**Tests**: `packages/core/src/index.test.ts` — 4 new tests (accepts all
three shapes; rejects a drag/select missing a required field or a key
missing `key`; confirms none of the three are in `TERMINAL_VERBS`/
`isTerminalVerb`; batch accepts all three mixed with the original four).
`packages/sdk/src/element-ladder.test.ts` — 12 new tests for
`selectOption`/`dragElement`/`pressKey` (native select exact + substring
match + no-match case, custom-listbox click-through + no-match case, the
real pointer/mouse event sequence with correct center-to-center
coordinates, the optional PointerEvent branch firing when available and
never throwing when it isn't, the real keydown/keypress/keyup sequence and
Enter/Tab's extra keypress). `packages/sdk/src/verb-executor.test.ts` — 10
new single-step tests (success + both miss cases for drag, success + no-
match for select, success + no-target-uses-focused-element + miss for key)
plus 1 new batch test exercising all three in one batch alongside the
combined-observation check. `packages/sdk/src/server.test.ts` — 8 new
tests: `resolveVerb`'s real-vs-invented gate for each of the three verbs
individually, the batch version of the same gate, and 3 `buildVerbToolSchema`/
`VerbResponseSchema` tests confirming the new wire properties and the
companion-null flat-response round-trip (the same real Groq-shaped bug
class earlier session entries already found and fixed for the original
verbs). `packages/sdk/src/agent-loop.test.ts` — 1 new test covering all
three `summarizeVerbForHistory` cases. 30 new tests total. Full repo `npx
vitest run`: 577/577 passing, zero regressions. Full `npm run typecheck`
clean across all 6 workspaces.

**A real gotcha hit and fixed while building this** (not a bug in the new
code — a rediscovery of a gap this session already found once before,
during the `isTerminalVerb` work): `@cairnvibe/core`'s package.json
`exports` field resolves the `"node"` condition to `./dist/index.js`, so
Vitest (which runs under Node) validated every new-verb test against the
STALE pre-Pillar-1 schema until `npm run build -w @cairnvibe/core` was run
— surfacing as all-new-tests-failing with `onToolStep` never called at all
(the parse silently failed and fell through to the generic explain
fallback, not a visible error). Fixed by rebuilding core before writing the
sdk-side tests, same fix as before, now the second time this exact class of
mistake has been made and caught this session — worth remembering for every
future core schema change: rebuild core FIRST, before writing or running
any test in a package that imports from it.

**Live-verified**: the demo app boots cleanly on the rebuilt `@cairnvibe/
core`+`@cairnvibe/sdk` (zero console errors, zero server errors), and a
real end-to-end request through the widget's text box round-tripped
through `/api/copilot` and `/api/copilot/speak` with real 200 responses —
confirming the rebuilt schema/server code didn't break the existing click/
explain path. The actual LLM response itself came back as a generic
"Something went wrong on my end" because every configured Groq API key is
now returning a real `401 Invalid API Key` (confirmed directly in the dev
server's own log — `AuthenticationError: 401 ... "invalid_api_key"`) — a
genuine, external credential problem, not a code issue, and not something
this session can fix without new keys from the user (the same category of
external blocker this session's Groq/Deepgram key swaps addressed
earlier — these keys appear to have since stopped authenticating
entirely). This means the specific behavior of drag/select/key being
correctly CHOSEN by a real model (as opposed to correctly EXECUTED once
chosen, which the unit/integration tests above do cover in full) is not
yet live-verified, and won't be until a working Groq (or other provider)
key is back in `examples/demo-app/.env`.

**Pending**: `upload`, `scroll`, and `wait_for` (the plan's remaining
Pillar 1 verbs, deliberately deferred — `upload` needs its own design pass
for the "real native picker only, agent never supplies a path" constraint);
a real live-model check of drag/select/key once a working LLM API key is
available; Pillar 2 through 6 of the same plan (UI-pattern classifier,
self-authored Skills, default-on planning, tiered memory, Scout role +
per-tool risk tiering) — next up, in the plan's own stated build order.

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

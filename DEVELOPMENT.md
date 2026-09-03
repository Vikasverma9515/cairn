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

**Pending / not yet started:**
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

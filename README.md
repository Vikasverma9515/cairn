# Cairn

Your app explains itself to your users — and talks them through it, in
real time, by voice. Generated from your code, in your CI.

Status: working end-to-end, including live LLM calls (Anthropic or Groq)
and live voice (Deepgram STT/TTS). **Next.js is the only framework Cairn's
analyzer understands today** — the runtime (voice, verb execution, element
finding) is already framework-agnostic under the hood, but there's no
installer for anything else yet. See [ROADMAP.md](./ROADMAP.md) for the
plan to fix that, and [LATER.md](./LATER.md) for smaller gaps within the
current Next.js scope. See [BUILD_PLAN.md](./BUILD_PLAN.md) for the
original design.

Not published to npm yet — install via a `file:` path pointing at this repo
(see Quick start) until that changes.

## How it works

```
repo ──► L1 AST scan ──► L2 reachability ──► L3 describe (LLM) ──► ui-manifest.json
         (ts-morph)       (graph walk)        Anthropic or Groq
         deterministic     deterministic       judgment, cached
```

`ui-manifest.json` ships as a static asset in your build. At runtime, a
`<Copilot/>` widget reads the user's question + current route + visible
`data-ai` elements, sends them to your own `/api/copilot` route, and gets back
exactly one verb from a fixed enum (`explain` / `highlight` / `open` /
`navigate` / `do`) — never a selector, never code. A lookup failure always
degrades to a plain explanation; it never guesses and clicks the wrong thing.
Every LLM response is independently re-validated server-side against that
same fixed schema, so a prompt-injection attempt in the user's question can't
produce an unregistered action — see `packages/sdk/src/server.test.ts`.

## Quick start

```bash
npm install
npm run build -w @cairn/indexer   # compiles the cairn CLI (packages/indexer/dist) — needed once
cp .env.example .env              # fill in ANTHROPIC_API_KEY or GROQ_API_KEYS (see .env.example)

npx cairn build ./examples/demo-app             # writes examples/demo-app/ui-manifest.json
npx cairn build ./examples/demo-app --provider groq   # or use Groq instead

npm run dev -w demo-app                         # or: cd examples/demo-app && npm run dev
# (npm run dev also auto-builds the manifest via predev if it's missing)
```

`@cairn/core` and `@cairn/sdk` ship raw TypeScript (bundlers like Next.js
transpile them fine via `transpilePackages`), but the `cairn` CLI runs
standalone via plain `node`, outside any bundler — it needs the one-time
compile above. This is also what makes it installable into a real, separate
project: point a consumer's `package.json` at
`"@cairn/indexer": "file:../cairn/packages/indexer"` (etc.) the way
`~/Desktop/cairn-dashboard` does in this session's testing — an actual
second Next.js app, outside this repo, installed as a real dependency
rather than another workspace example, used to prove Cairn works as an
installed product and not just inside its own monorepo.

```jsx
// app/layout.tsx
import { Copilot } from "@cairn/sdk";

<Copilot
  registeredActions={["archiveInvoice"]}
  onDo={(action, target) => { /* run the write action through YOUR session auth */ }}
  reportMissesEndpoint="/api/copilot/misses" // optional — aggregate lookup misses server-side
  transcribeEndpoint="/api/copilot/transcribe" // optional — adds a mic button (needs Deepgram)
/>;
```

```ts
// app/api/copilot/route.ts — your own route, your own API key, your own auth
import { createCopilotHandler } from "@cairn/sdk/server";
import manifest from "../../../ui-manifest.json";

const handler = createCopilotHandler(manifest, {
  provider: "groq", // or "anthropic" (default)
  registeredActions: ["archiveInvoice"],
});

export async function POST(request: Request) {
  const result = await handler(await request.json());
  return Response.json(result.body, { status: result.status });
}
```

Mark anything you want addressed by a stable id, regardless of copy changes:

```jsx
<button data-ai="create-invoice">New Invoice</button>
```

`<Link>` and any `*Button`-named component with an `onClick` are also picked
up automatically (heuristic — see LATER.md), so `data-ai` is for precision,
not a requirement.

## Voice & conversation

Beyond typed questions, `<Copilot/>` can hold a real spoken conversation —
run `cairn-realtime` (from `@cairn/sdk`, its own long-lived process
alongside `next dev`) and pass `realtimeUrl` to the widget:

```jsx
<Copilot
  registeredActions={["archiveInvoice"]}
  onDo={handleDo}
  speakEndpoint="/api/copilot/speak"        // typed/mic answers spoken aloud (Deepgram TTS)
  transcribeEndpoint="/api/copilot/transcribe" // push-to-talk mic button (Deepgram STT)
  realtimeUrl="ws://localhost:3010"         // full live voice conversation
  persona="Cairn"                            // display name, woven into the system prompt
/>
```

```bash
# .env: DEEPGRAM_API_KEY, CAIRN_REGISTERED_ACTIONS, CAIRN_CAPABILITY, CAIRN_PERSONA
npx cairn-realtime --port 3010
```

What that gets you:
- **Streaming speech, not a wait-then-play clip.** TTS is a persistent
  Deepgram WebSocket, not a buffered REST call — audio starts within
  ~1-1.5s instead of 5-10s (`packages/sdk/src/tts-stream.ts`).
- **Barge-in.** Talk over the agent and it stops immediately — a local mic
  energy check triggers it client-side, the server drops any audio already
  in flight for the interrupted turn.
- **Tours.** A question whose answer spans several elements (or several
  pages) comes back as an ordered walkthrough — highlight, narrate, move
  on — instead of one paragraph naming five buttons at once.
- **Conversation memory.** "Highlight that instead" resolves against the
  last few turns, not just the current question.
- **Capability tiers.** `capability: "explain" | "guide" | "act"` (default
  `"act"`) caps what the agent is *allowed* to do independent of which
  actions are registered — `"explain"` can only talk and point,
  `"guide"` adds moving around the app, `"act"` adds real actions.

Every spoken/displayed `text` is held to one rule regardless of path: no
markdown, never say an internal element id out loud — see
`buildSystemPrompt` in `packages/sdk/src/server.ts`.

## CLI

```bash
cairn scan <dir>                          # L1 only, deterministic, no LLM call
cairn build <dir> [--provider anthropic|groq]
cairn diff <old-manifest.json> <new-manifest.json>   # what changed between two builds
cairn docs <dir>                          # reads <dir>/ui-manifest.json, writes CAIRN_DOCS.md
```

## Data & persistence

| Data | Where it lives |
|---|---|
| `ui-manifest.json` | A file on disk, checked into your build (not a database) — it's a build artifact, versioned by commit, meant to be diffable (`cairn diff`) and shippable as a static asset. The demo app's `/api/copilot` route re-reads it on every request, so a `cairn build` while the dev server is running takes effect on the next question — no restart needed. |
| Failure-dashboard misses | `@cairn/sdk/dashboard`'s in-memory `createMissesStore()` is the default (fine for a single instance, gone on restart) — but for anything that needs to survive restarts/redeploys, use `createSqliteMissesStore` from `@cairn/sdk/dashboard-sqlite`, which implements the exact same `MissesStore` interface against a real SQLite file. The demo app uses the SQLite version. |
| The demo app's own data (invoices) | SQLite, `examples/demo-app/data/cairn-demo.db` (gitignored, created on first run) — a real example of how you'd persist your own app's data alongside Cairn, not a toy in-memory array. |

## Repo layout

```
packages/
  core/      @cairn/core    — manifest + verb schemas (zod), shared by indexer and sdk
  indexer/   @cairn/indexer — the `cairn` CLI: L1 scan, L2 reachability, L3 describe, diff, docs
  sdk/       @cairn/sdk     — <Copilot/>, verb executor, element ladder, server handler,
                               failure dashboard (./dashboard), voice transcription (./transcribe-server)
examples/demo-app/          — Next.js app exercising all of the above, including a real
                               archive-invoice write action and a live failure dashboard
fixtures/                   — small fixture project the indexer's unit tests scan
```

## Testing

```bash
npm test          # vitest across all packages — L1/L2/L3 (mocked + real-provider-shaped fakes),
                   # core schemas, verb executor, server handler (Anthropic + Groq), dashboard, diff, docs
npm run typecheck
npm run determinism   # `cairn scan` twice, diff must be empty — no API key required
```

## License

MIT

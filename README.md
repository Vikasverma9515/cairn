# Cairn

Your app explains itself to your users. Generated from your code, in your CI.

Status: working end-to-end, including live LLM calls (Anthropic or Groq).
Next.js App Router is the primary target; Pages Router is also scanned for
reachability/routes (see [LATER.md](./LATER.md) for what isn't fully wired
yet). See [BUILD_PLAN.md](./BUILD_PLAN.md) for the original design.

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
cp .env.example .env   # fill in ANTHROPIC_API_KEY or GROQ_API_KEYS (see .env.example)

npx cairn build ./examples/demo-app             # writes examples/demo-app/ui-manifest.json
npx cairn build ./examples/demo-app --provider groq   # or use Groq instead

npm run dev -w demo-app                         # or: cd examples/demo-app && npm run dev
```

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

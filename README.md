# Cairn

Your app explains itself to your users. Generated from your code, in your CI.

Status: MVP. Explain + highlight, Next.js App Router only. See
[BUILD_PLAN.md](./BUILD_PLAN.md) for the full design and [LATER.md](./LATER.md)
for what's deliberately out of scope right now.

## How it works

```
repo ──► L1 AST scan ──► L2 reachability ──► L3 describe (LLM) ──► ui-manifest.json
         (ts-morph)       (graph walk)        (Anthropic API)
         deterministic     deterministic       judgment, cached
```

`ui-manifest.json` ships as a static asset in your build. At runtime, a
`<Copilot/>` widget reads the user's question + current route + visible
`data-ai` elements, sends them to your own `/api/copilot` route, and gets back
exactly one verb from a fixed enum (`explain` / `highlight` / `open` /
`navigate` / `do`) — never a selector, never code. A lookup failure always
degrades to a plain explanation; it never guesses and clicks the wrong thing.

## Quick start

```bash
npm install
export ANTHROPIC_API_KEY=sk-ant-...        # needed for `cairn build` and the demo's /api/copilot

npx cairn build ./examples/demo-app         # writes examples/demo-app/ui-manifest.json
npm run dev -w demo-app                     # or: cd examples/demo-app && npm run dev
```

```jsx
// app/layout.tsx
import { Copilot } from "@cairn/sdk";

<Copilot registeredActions={["archiveInvoice"]} />;
```

```ts
// app/api/copilot/route.ts — your own route, your own API key, your own auth
import { createCopilotHandler } from "@cairn/sdk/server";
import manifest from "../../../ui-manifest.json";

const handler = createCopilotHandler(manifest, { registeredActions: ["archiveInvoice"] });

export async function POST(request: Request) {
  const result = await handler(await request.json());
  return Response.json(result.body, { status: result.status });
}
```

Mark anything you want addressed by a stable id, regardless of copy changes:

```jsx
<button data-ai="create-invoice">New Invoice</button>
```

## Repo layout

```
packages/
  core/      @cairn/core    — manifest + verb schemas (zod), shared by indexer and sdk
  indexer/   @cairn/indexer — the `cairn` CLI: L1 scan, L2 reachability, L3 describe
  sdk/       @cairn/sdk     — <Copilot/>, verb executor, element ladder, server handler
examples/demo-app/          — Next.js app used for every test in this repo
fixtures/                   — small fixture project the indexer's unit tests scan
```

## Testing

```bash
npm test          # vitest across all packages — L1/L2/L3 (mocked LLM), core schemas, verb executor + server handler
npm run typecheck
npm run determinism   # `cairn scan` twice, diff must be empty — no API key required
```

## License

MIT

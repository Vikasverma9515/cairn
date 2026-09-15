// Generates .cairn/CAIRN.md — a reference doc `cairn setup`/`cairn init`
// installs INTO the consuming project, not into this repo. Distinct
// audience from everything else this package writes: not the app's end
// user, not even the developer necessarily — an AI coding agent (Claude
// Code, Cursor, Copilot, etc.) working in that project later, asked to
// "fix the Cairn widget" or "the voice thing isn't working," with zero
// memory of this install and no reason to already know Cairn's own
// architecture. Real, live-found gap this closes: every other artifact
// `cairn setup` writes (cairn-server.cjs, the widget script tag,
// install-manifest.json) is either machine-consumed or too narrow to
// explain the WHOLE system — nothing installed told a future reader what
// Cairn even is, how its pieces fit together, or where to look first when
// something breaks.
//
// Regenerated (not writeIfAbsent) on every `cairn setup`/`cairn init` run
// — it reflects the CURRENT config (provider, voice on/off, ports, which
// files exist), so a stale copy describing an old setup would be actively
// misleading. Tracked in the install manifest like everything else
// generated, so `cairn remove` deletes it along with the rest.

export interface CairnDocOptions {
  framework: "next-app-router" | "next-pages-router" | "other";
  voice: boolean;
  provider: "anthropic" | "groq" | "gemini" | null;
  packageVersion: string;
  /** Only meaningful when framework === "other" — the standalone
   * backend's port and the realtime relay's port, so the doc's own
   * troubleshooting section names the exact URLs this install actually
   * uses instead of a generic placeholder. */
  standaloneApiPort?: number;
  realtimePort?: number;
}

const REPO_URL = "https://github.com/Vikasverma9515/cairn";

export function buildCairnAgentsDoc(opts: CairnDocOptions): string {
  const { framework, voice, provider, packageVersion } = opts;
  const isOther = framework === "other";
  const apiPort = opts.standaloneApiPort ?? 4000;
  const rtPort = opts.realtimePort ?? 3010;

  const integrationSection = isOther
    ? `## How Cairn is wired into THIS project

This is a **non-Next.js** project, so Cairn runs as its own small standalone
service alongside your real app — it does not live inside your backend's
own code, whatever language that is.

| Piece | File | What it does |
|---|---|---|
| The widget | your HTML entry file (has \`<!-- cairn:start -->\` / \`<!-- cairn:end -->\` markers) | A \`<script>\` tag loading \`cairn-widget.js\` + a \`<cairn-widget>\` custom element. Pure client-side — talks to the backend below over plain HTTP/WebSocket. |
| The widget bundle | \`cairn-widget.js\`, sitting next to your HTML entry file | A built copy of \`@cairnvibe/sdk\`'s Web Component (\`packages/sdk/src/web-component.ts\` in the Cairn repo). Static asset — served by whatever already serves your HTML. |
| The backend | \`cairn-server.cjs\` | A standalone Express server (own process, own port \`${apiPort}\`) exposing \`POST /api/copilot\`${voice ? ", `POST /api/copilot/speak`, `POST /api/copilot/transcribe`" : ""}. This is where your LLM API key actually gets used — never in the browser. |
${voice ? `| The voice relay | (no file — runs via \`npx cairn-realtime\`) | A persistent WebSocket server (port \`${rtPort}\`) for real-time voice conversation: streams mic audio in, streams TTS audio back, handles barge-in. Must be a genuinely long-running process — will NOT work on a serverless host (Vercel/Netlify functions). |
` : ""}| The orchestrator | \`cairn-dev.cjs\` (only if your project had a \`"dev"\` script) | Spawns your app's own dev command + the pieces above together, so \`npm run dev\` is still one command. |
| The manifest | \`.cairn/ui-manifest.json\` | What the agent knows about your app's pages/elements. Built by **crawling a running instance** (\`npx cairn build <url>\`) — this project has no file-based routing convention to read source from directly, unlike Next.js. |

**Nothing above touches your actual backend.** The widget calls \`cairn-server.cjs\` directly, at \`http://localhost:${apiPort}\` in dev (point it at wherever you deploy that process, in production). Your real backend, in whatever language it's written, is never involved.`
    : `## How Cairn is wired into THIS project

This is a **${framework === "next-app-router" ? "Next.js App Router" : "Next.js Pages Router"}** project, so Cairn's backend runs as real API route(s) inside your own Next.js server — no separate process for text/typed Q&A.

| Piece | File | What it does |
|---|---|---|
| The widget | \`components/CairnCopilot.tsx\` (a \`"use client"\` wrapper around \`<Copilot/>\`), referenced from your real layout file | The React entry point (\`@cairnvibe/sdk\`'s \`<Copilot/>\`). The wrapper exists so no function prop crosses the Server/Client Component boundary — see that file's own comment if editing it directly. |
| The backend | \`${framework === "next-app-router" ? "app/api/copilot/route.ts" : "pages/api/copilot.ts"}\`${voice ? ` + \`speak\`/\`transcribe\` routes next to it` : ""} | Runs inside your Next.js server itself — same deploy, same process, no extra infrastructure for typed Q&A. |
${voice ? `| The voice relay | \`cairn-realtime\` (wired into your \`"dev"\` script — check \`package.json\` for \`cairn-realtime --with ...\`) | A SEPARATE persistent WebSocket process from Next.js itself (port \`${rtPort}\`), for real-time voice. Must run as a genuinely long-lived process in production too — a Vercel/Netlify serverless deploy of Next.js does NOT give you this for free; you need something else to host it. |
` : ""}| The manifest | \`.cairn/ui-manifest.json\` | Built by reading your own source (\`npx cairn build .\`) — App/Pages Router file conventions, real AST parsing, not a live crawl. Regenerates automatically on \`npm run build\` via a \`"prebuild"\` script, if one was added. |`;

  return `# Cairn — what this project has installed, and how to work on it

This file exists for whoever (human or AI coding agent) opens this project
later and needs to understand, extend, debug, or remove **Cairn** — an
in-app AI agent that reads this app's own UI and can explain it, navigate
it, and (if you've registered actions) actually operate it, live, driven
by conversation or voice. It was installed by \`cairn setup\` /
\`cairn init\` (\`@cairnvibe/indexer@${packageVersion}\`) and is regenerated
every time that command runs, so it always reflects the CURRENT
configuration — if this looks stale, re-run \`npx cairn setup\`.

Upstream source, issues, and the full architecture: ${REPO_URL}

## What Cairn actually is, in one paragraph

A small widget embedded in this app (either \`<Copilot/>\` for React, or
\`<cairn-widget>\` as a plain Web Component for anything else) that lets a
user ask a question or give a goal in plain language. A backend handler
resolves that into one of a fixed set of **verbs** — \`explain\`,
\`navigate\`, \`highlight\`, \`do\` (click/type/drag/select/key/scroll on a
real DOM element), \`tour\` (a guided multi-step walkthrough) — grounded in
a **manifest** (\`.cairn/ui-manifest.json\`) that was built by either
reading this app's own source or crawling it while running. The agent
never invents a UI element that doesn't exist; every action resolves
through a real element-matching ladder (data-ai attribute → aria-label →
visible text → placeholder/name) against the live DOM, and misses are
logged rather than guessed.

${integrationSection}

## Common issues, and where to actually look

**"The widget doesn't appear at all."**
- ${isOther ? "Check your HTML entry file for the `<!-- cairn:start -->` block — if it's missing, injection failed silently at setup time; add it by hand (see the block's own contents for the exact tags) or re-run `cairn setup`." : "Check your layout file for `<CairnCopilot />` — if it's missing, injection failed at setup time; add `import { Copilot } from \"@cairnvibe/sdk\"` and `<Copilot registeredActions={[]} onDo={...} />` yourself inside a `\"use client\"` component."}
- Open the browser console — the widget logs \`[cairn]\`-prefixed messages, including element-matching misses (\`logMiss\`).

**"It answers but everything sounds like it knows nothing about my app."**
- \`.cairn/ui-manifest.json\` is missing or stale. Run \`npx cairn build ${isOther ? "<your-running-app-url>" : "."}\` and restart.

**"Voice doesn't work / mic button does nothing."**
${voice ? `- The realtime relay (port \`${rtPort}\`) has to actually be running. In dev, check that \`npm run dev\` is starting it — look for \`cairn-realtime: listening on ws://localhost:${rtPort}\` in the terminal output. In production, confirm it's deployed as its own persistent process, not inside a serverless function.
- Browser mic permission was denied, or the page isn't served over HTTPS (or localhost) — \`getUserMedia\` requires one of those.
- Check \`DEEPGRAM_API_KEY\` is actually set in \`.env\` — a missing/invalid key fails silently into "Something went wrong" from the widget's perspective; the real error is server-side.` : `- Voice wasn't set up on this install (no Deepgram key configured). Re-run \`npx cairn setup\` and choose "Set up voice now."`}

**"CORS error in the console calling the Cairn endpoint."**
${isOther ? `- \`cairn-server.cjs\` already has \`app.use(cors())\` — if you still see this, confirm the widget's \`endpoint\`/\`speak-endpoint\`/\`transcribe-endpoint\`/\`realtime-url\` attributes actually point at where \`cairn-server.cjs\` is really running (they default to \`http://localhost:${apiPort}\` — wrong once you deploy it elsewhere).` : `- Shouldn't happen on this Next.js setup (same-origin API routes) — if it does, something's proxying requests through a different origin than expected; check next.config for rewrites."`}

**"Rate limited" / "invalid key" errors from the LLM provider.**
- Cairn rotates across every comma-separated key in \`GROQ_API_KEYS\` (or the single \`ANTHROPIC_API_KEY\`/\`GEMINI_API_KEY\`) and marks a confirmed-dead key out of rotation for the rest of the process — a genuinely exhausted key set surfaces as a real error, not a silent hang. Check server logs for \`[cairn]\`-prefixed messages naming which key/provider failed.
- Current provider on this install: **${provider ?? "not set — add one to .env"}**.

**"An element the agent tries to act on can't be found."**
- Logged as a miss (\`[cairn miss]\` in the console, or POSTed to \`report-misses-endpoint\` if configured) — the fix is almost always adding a \`data-ai="stable-id"\` attribute to that element in your own source, which the matching ladder always prefers first.

## How to extend it

- **Let the agent actually DO things, not just explain**: pass \`registeredActions={["create-invoice", "archive-item"]}\` (React) or \`registered-actions="create-invoice,archive-item"\` (Web Component attribute) — a comma-separated allowlist — and handle the resulting \`onDo\`/\`cairn-do\` event yourself.
- **Cap what it's allowed to do at all**: \`CAIRN_CAPABILITY\` in \`.env\` — \`explain\` (read-only), \`guide\` (+ navigate/highlight/tour), or \`act\` (+ do) — default \`act\`.
- **Give it a different voice/name**: \`CAIRN_PERSONA\` in \`.env\`, or the \`persona\` prop/attribute.
- **Re-scan after real UI changes**: ${isOther ? "`npx cairn build <your-running-app-url>` (app must be running)" : "`npx cairn build .` (regenerates automatically on `npm run build` if a prebuild script was added)"}.

## Fixing a real bug in Cairn itself (not just this integration)

The agent's own logic — verb resolution, the Planner/Critic loop, the
element-matching ladder, the realtime voice pipeline — lives in the
\`@cairnvibe/sdk\` and \`@cairnvibe/core\` packages themselves (installed
into \`node_modules\`), not in anything generated into this project. To fix
or improve that logic (not just this project's own wiring):

1. Reproduce against the actual upstream repo: ${REPO_URL}
2. Key source locations, for orientation: \`packages/sdk/src/server.ts\`
   (verb/plan/critic resolution, system prompt construction),
   \`packages/sdk/src/element-ladder.ts\` (DOM element matching),
   \`packages/sdk/src/agent-loop.ts\` (the multi-step execution loop),
   \`packages/sdk/src/web-component.ts\` / \`index.tsx\` (the widget itself,
   Web Component and React respectively), \`packages/indexer/src/\` (the
   \`cairn\` CLI — scanning, crawling, \`setup\`/\`init\`/\`remove\`).
3. \`DEVELOPMENT.md\` in that repo has the real, dated history of what was
   built and why — genuinely useful before assuming something is a fresh
   bug rather than a known, already-documented tradeoff.
4. Open an issue or PR against the repo above rather than patching
   \`node_modules\` directly — a local patch there is silently lost on the
   next \`npm install\`.

## Uninstalling

\`npx cairn remove\` reverses exactly what \`cairn setup\`/\`cairn init\`
did — every generated file, the widget wiring, the \`"dev"\` script
rewrite — tracked precisely in \`.cairn/install-manifest.json\`. It never
touches your own \`.env\`/\`.env.local\` credentials; you're told what's
still there afterward so you can remove them yourself if you want to.
`;
}

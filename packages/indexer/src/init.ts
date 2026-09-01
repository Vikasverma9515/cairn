// `cairn init` — scaffolds what it safely can, prints the rest. Only ever
// writes NEW files (never touches an existing file, e.g. a layout the
// user already has) — auto-editing arbitrary existing project files is
// not something a generic CLI should do blind.

import fs from "node:fs";
import path from "node:path";

export interface InitResult {
  framework: "next-app-router" | "next-pages-router" | "other";
  filesWritten: string[];
  filesSkipped: string[]; // already existed
  nextSteps: string[];
}

const ENV_TEMPLATE = `# Pick one LLM provider:
ANTHROPIC_API_KEY=
# or:
# GROQ_API_KEYS=

# Optional — voice (transcription/spoken answers/realtime conversation):
DEEPGRAM_API_KEY=

# Which "do" actions this deployment allows (comma-separated, empty = none):
CAIRN_REGISTERED_ACTIONS=

# Optional — caps what the agent can do regardless of registered actions:
# explain | guide | act (default act) — see README.md's Voice & conversation section
CAIRN_CAPABILITY=
CAIRN_PERSONA=
`;

function writeIfAbsent(filePath: string, content: string, result: InitResult): void {
  if (fs.existsSync(filePath)) {
    result.filesSkipped.push(filePath);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  result.filesWritten.push(filePath);
}

export interface RunInitOptions {
  /** Also scaffold /api/copilot/speak and /api/copilot/transcribe (Deepgram-backed) —
   * real bug this closes: previously nothing wrote these routes for a Next.js
   * project no matter what, so choosing voice during `cairn setup` silently did
   * nothing beyond saving a key nothing used. Ignored for the standalone-server
   * path, which already conditionally wires speak in STANDALONE_SERVER. */
  voice?: boolean;
}

export function runInit(dir: string, options: RunInitOptions = {}): InitResult {
  const absDir = path.resolve(dir);
  const pkgPath = path.join(absDir, "package.json");
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
  if (fs.existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      // malformed package.json — fall through to the generic (non-Next) path
    }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const isNext = !!deps.next;
  const hasAppDir = fs.existsSync(path.join(absDir, "app"));

  const result: InitResult = {
    framework: !isNext ? "other" : hasAppDir ? "next-app-router" : "next-pages-router",
    filesWritten: [],
    filesSkipped: [],
    nextSteps: [],
  };

  writeIfAbsent(path.join(absDir, ".env.example"), ENV_TEMPLATE, result);

  if (result.framework === "next-app-router") {
    writeIfAbsent(path.join(absDir, "app", "api", "copilot", "route.ts"), NEXT_APP_ROUTE, result);
    const widgetProps = ['registeredActions={[]}', "onDo={(action, target) => { /* run it */ }}"];
    if (options.voice) {
      writeIfAbsent(path.join(absDir, "app", "api", "copilot", "speak", "route.ts"), NEXT_APP_SPEAK_ROUTE, result);
      writeIfAbsent(path.join(absDir, "app", "api", "copilot", "transcribe", "route.ts"), NEXT_APP_TRANSCRIBE_ROUTE, result);
      widgetProps.push('speakEndpoint="/api/copilot/speak"', 'transcribeEndpoint="/api/copilot/transcribe"');
    }
    result.nextSteps.push(
      "1. cp .env.example .env and fill in your key(s).",
      "2. Add the widget to app/layout.tsx:",
      '   import { Copilot } from "@cairnvibe/sdk";',
      `   <Copilot ${widgetProps.join(" ")} />`,
      "3. npx cairn build .   (scans this Next.js app's source)",
      "4. npm run dev, then ask it a question.",
    );
  } else if (result.framework === "next-pages-router") {
    writeIfAbsent(path.join(absDir, "pages", "api", "copilot.ts"), NEXT_PAGES_API_ROUTE, result);
    const widgetProps = ['registeredActions={[]}', "onDo={(action, target) => { /* run it */ }}"];
    if (options.voice) {
      writeIfAbsent(path.join(absDir, "pages", "api", "copilot", "speak.ts"), NEXT_PAGES_SPEAK_ROUTE, result);
      writeIfAbsent(path.join(absDir, "pages", "api", "copilot", "transcribe.ts"), NEXT_PAGES_TRANSCRIBE_ROUTE, result);
      widgetProps.push('speakEndpoint="/api/copilot/speak"', 'transcribeEndpoint="/api/copilot/transcribe"');
    }
    result.nextSteps.push(
      "1. cp .env.example .env and fill in your key(s).",
      "2. Add the widget to pages/_app.tsx:",
      '   import { Copilot } from "@cairnvibe/sdk";',
      `   <Copilot ${widgetProps.join(" ")} />`,
      "3. npx cairn build .   (scans this Next.js app's source)",
      "4. npm run dev, then ask it a question.",
    );
  } else {
    writeIfAbsent(path.join(absDir, "cairn-server.cjs"), STANDALONE_SERVER, result);
    result.nextSteps.push(
      "1. cp .env.example .env and fill in your key(s).",
      "2. npm install express @cairnvibe/sdk @cairnvibe/core",
      "3. Start your app, then: npx cairn build http://localhost:PORT   (crawls the running app — works for any framework)",
      "4. node cairn-server.cjs   (the copilot backend, separate from your app's own server)",
      "5. Add this to your HTML, pointed at wherever cairn-server.cjs is running:",
      '   <script src="/cairn-widget.js"></script>',
      '   <cairn-widget endpoint="http://localhost:4000/api/copilot"></cairn-widget>',
      "   (copy node_modules/@cairnvibe/sdk/dist/cairn-widget.js into your app's static assets as cairn-widget.js)",
    );
  }

  return result;
}

const NEXT_APP_ROUTE = `import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createCopilotHandler } from "@cairnvibe/sdk/server";
import { ManifestSchema, type Manifest } from "@cairnvibe/core";

function loadManifest(): Manifest {
  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (fs.existsSync(manifestPath)) {
    return ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  }
  console.warn("[cairn] no ui-manifest.json — run \`npx cairn build .\` first. Serving an empty manifest.");
  return { version: "1", commit: "unbuilt", generatedAt: new Date().toISOString(), pages: [], dead: [], conflicts: [] };
}

export async function POST(request: Request) {
  const handler = createCopilotHandler(loadManifest(), {
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
    registeredActions: (process.env.CAIRN_REGISTERED_ACTIONS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    capability: (process.env.CAIRN_CAPABILITY as "explain" | "guide" | "act" | undefined) ?? "act",
    persona: process.env.CAIRN_PERSONA || undefined,
  });
  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}
`;

const NEXT_PAGES_API_ROUTE = `import fs from "node:fs";
import path from "node:path";
import type { NextApiRequest, NextApiResponse } from "next";
import { createCopilotHandler } from "@cairnvibe/sdk/server";
import { ManifestSchema, type Manifest } from "@cairnvibe/core";

function loadManifest(): Manifest {
  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (fs.existsSync(manifestPath)) {
    return ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  }
  console.warn("[cairn] no ui-manifest.json — run \`npx cairn build .\` first. Serving an empty manifest.");
  return { version: "1", commit: "unbuilt", generatedAt: new Date().toISOString(), pages: [], dead: [], conflicts: [] };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const copilotHandler = createCopilotHandler(loadManifest(), {
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
    registeredActions: (process.env.CAIRN_REGISTERED_ACTIONS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    capability: (process.env.CAIRN_CAPABILITY as "explain" | "guide" | "act" | undefined) ?? "act",
    persona: process.env.CAIRN_PERSONA || undefined,
  });
  const result = await copilotHandler(req.body);
  res.status(result.status).json(result.body);
}
`;

// The exact shape examples/demo-app's already-working routes use — copied,
// not reinvented, since that's the one place in this repo these have
// actually been proven against real Deepgram calls.
const NEXT_APP_SPEAK_ROUTE = `import { createSpeakHandler } from "@cairnvibe/sdk/speak-server";

const handler = createSpeakHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

export async function POST(request: Request) {
  const { text } = await request.json().catch(() => ({ text: "" }));
  const result = await handler(text ?? "");

  if ("error" in result.body) {
    return Response.json(result.body, { status: result.status });
  }
  return new Response(result.body.audio, {
    status: result.status,
    headers: { "content-type": result.body.contentType },
  });
}
`;

const NEXT_APP_TRANSCRIBE_ROUTE = `import { NextResponse } from "next/server";
import { createTranscribeHandler } from "@cairnvibe/sdk/transcribe-server";

const handler = createTranscribeHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

export async function POST(request: Request) {
  const contentType = request.headers.get("content-type") ?? "audio/webm";
  const buffer = await request.arrayBuffer();
  const result = await handler(buffer, contentType);
  return NextResponse.json(result.body, { status: result.status });
}
`;

const NEXT_PAGES_SPEAK_ROUTE = `import type { NextApiRequest, NextApiResponse } from "next";
import { createSpeakHandler } from "@cairnvibe/sdk/speak-server";

const handler = createSpeakHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

export default async function speak(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const result = await handler(req.body?.text ?? "");
  if ("error" in result.body) {
    return res.status(result.status).json(result.body);
  }
  res.status(result.status).setHeader("content-type", result.body.contentType).send(Buffer.from(result.body.audio));
}
`;

const NEXT_PAGES_TRANSCRIBE_ROUTE = `import type { NextApiRequest, NextApiResponse } from "next";
import { createTranscribeHandler } from "@cairnvibe/sdk/transcribe-server";

const handler = createTranscribeHandler({ apiKey: process.env.DEEPGRAM_API_KEY ?? "" });

// Pages Router's default body parser only handles JSON/form bodies — raw
// audio bytes need this off so the handler gets the untouched buffer.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export default async function transcribe(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();
  const contentType = req.headers["content-type"] ?? "audio/webm";
  const buffer = await readRawBody(req);
  const result = await handler(buffer, contentType);
  res.status(result.status).json(result.body);
}
`;

const STANDALONE_SERVER = `// cairn-server.cjs — generated by \`cairn init\`. Any backend framework
// works here (createCopilotHandler is plain Node) — this is just the
// simplest one to scaffold. Run: node cairn-server.cjs
require("dotenv").config();
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const { createCopilotHandler } = require("@cairnvibe/sdk/server");
const { ManifestSchema } = require("@cairnvibe/core");

function loadManifest() {
  const manifestPath = path.join(__dirname, "ui-manifest.json");
  if (fs.existsSync(manifestPath)) {
    return ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
  }
  console.warn("[cairn] no ui-manifest.json — run \`npx cairn build <your-app-url>\` first. Serving an empty manifest.");
  return { version: "1", commit: "unbuilt", generatedAt: new Date().toISOString(), pages: [], dead: [], conflicts: [] };
}

const app = express();
app.use(express.json());

app.post("/api/copilot", async (req, res) => {
  const handler = createCopilotHandler(loadManifest(), {
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
    registeredActions: (process.env.CAIRN_REGISTERED_ACTIONS ?? "").split(",").map((a) => a.trim()).filter(Boolean),
    capability: process.env.CAIRN_CAPABILITY ?? "act",
    persona: process.env.CAIRN_PERSONA || undefined,
  });
  const result = await handler(req.body);
  res.status(result.status).json(result.body);
});

if (process.env.DEEPGRAM_API_KEY) {
  const { createSpeakHandler } = require("@cairnvibe/sdk/speak-server");
  const speak = createSpeakHandler({ apiKey: process.env.DEEPGRAM_API_KEY });
  app.post("/api/copilot/speak", async (req, res) => {
    const result = await speak(req.body?.text ?? "");
    if ("error" in result.body) return res.status(result.status).json(result.body);
    res.status(result.status).type(result.body.contentType).send(Buffer.from(result.body.audio));
  });
}

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(\`Cairn backend listening on http://localhost:\${port}\`));
`;

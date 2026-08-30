import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createCopilotHandler } from "@cairn/sdk/server";
import { ManifestSchema, type Manifest } from "@cairn/core";

function loadManifest(): Manifest {
  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return ManifestSchema.parse(raw);
  }
  // No `cairn build` has run yet (or it was deleted) — serve an empty
  // manifest instead of crashing the route, but say so loudly. Re-read on
  // every request (below) means the very next `cairn build` fixes this
  // without a server restart.
  console.warn(`[cairn] no ui-manifest.json at ${manifestPath} — run \`cairn build\`. Serving an empty manifest.`);
  return {
    version: "1",
    commit: "unbuilt",
    generatedAt: new Date().toISOString(),
    pages: [],
    dead: [],
    conflicts: [],
  };
}

export async function POST(request: Request) {
  // Re-read per request (it's a small local file) rather than caching at
  // module load — a `cairn build` while the dev server is running should
  // take effect on the next question, not require a restart.
  const handler = createCopilotHandler(loadManifest(), {
    // Defaults to Groq since that's what this demo ships configured with
    // (GROQ_API_KEYS in .env) — set CAIRN_RUNTIME_PROVIDER=anthropic to switch.
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
    registeredActions: ["archiveInvoice"],
  });

  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

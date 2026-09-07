import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createCopilotHandlerWithLLM } from "@cairnvibe/sdk/server";
import { ManifestSchema, type Manifest } from "@cairnvibe/core";
import { memory } from "../../../lib/agent-memory";
import { registeredActions, verbLLM } from "../../../lib/groq-llm";

// `.cairn/ui-manifest.json` is the new default `cairn build` writes to
// (everything generated that isn't Next.js-routing-mandated consolidates
// into one folder — see README.md's "Install into your own project").
// This app predates that and had its manifest sitting at the project
// root — checked SECOND, as a fallback: the new location has to win when
// both exist (any future `cairn build` here writes there, so preferring
// the old one would mean silently serving a permanently stale manifest
// after the very next rebuild), and it degrades correctly today too,
// before a fresh build has ever written the new file.
function resolveManifestPath(root: string): string {
  const modern = path.join(root, ".cairn", "ui-manifest.json");
  if (fs.existsSync(modern)) return modern;
  return path.join(root, "ui-manifest.json");
}

function loadManifest(): Manifest {
  const manifestPath = resolveManifestPath(process.cwd());
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
  // take effect on the next question, not require a restart. The LLM
  // itself (verbLLM) is a DIFFERENT concern, deliberately hoisted to
  // module scope in lib/groq-llm.ts — see that file's own doc comment for
  // why: rebuilding it fresh per request also rebuilt its KeyRotator from
  // scratch every time, silently forgetting any key already confirmed
  // dead by a real 401 the moment the request that discovered it finished.
  const handler = createCopilotHandlerWithLLM(loadManifest(), verbLLM, {
    registeredActions,
    // "act" lets it run the registered action above. "guide" or "explain"
    // would restrict it to moving the user around / just talking, even
    // though archiveInvoice stays registered — the two checks are independent.
    capability: "act",
    persona: "Cairn",
    memory,
  });

  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

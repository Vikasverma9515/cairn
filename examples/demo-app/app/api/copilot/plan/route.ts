import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createPlanHandlerWithLLM } from "@cairnvibe/sdk/server";
import { ManifestSchema, type Manifest } from "@cairnvibe/core";
import { skills, SKILLS_SCOPE_ID } from "../../../../lib/agent-memory";
import { planLLM, registeredActions } from "../../../../lib/groq-llm";

function loadManifest(): Manifest {
  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    return ManifestSchema.parse(raw);
  }
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
  // planLLM is a module-scope singleton (lib/groq-llm.ts) — see
  // /api/copilot/route.ts's own comment for why: rebuilding it fresh per
  // request also rebuilt its KeyRotator's dead-key memory from scratch
  // every time.
  const handler = createPlanHandlerWithLLM(loadManifest(), planLLM, {
    registeredActions,
    skills,
    skillsScopeId: SKILLS_SCOPE_ID,
  });

  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

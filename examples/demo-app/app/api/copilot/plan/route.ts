import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createPlanHandler } from "@cairnvibe/sdk/server";
import { ManifestSchema, type Manifest } from "@cairnvibe/core";

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
  const handler = createPlanHandler(loadManifest(), {
    provider: process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq",
    registeredActions: ["archiveInvoice"],
  });

  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

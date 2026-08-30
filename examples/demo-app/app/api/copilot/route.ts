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
  // No `cairn build` has run yet — serve an empty manifest instead of
  // crashing the route. The widget will just have nothing to talk about.
  return {
    version: "1",
    commit: "unbuilt",
    generatedAt: new Date().toISOString(),
    pages: [],
    dead: [],
    conflicts: [],
  };
}

const handler = createCopilotHandler(loadManifest(), {
  registeredActions: ["archiveInvoice"],
});

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

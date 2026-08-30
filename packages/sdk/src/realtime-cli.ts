#!/usr/bin/env node
// `cairn-realtime` — zero-code way to run the realtime voice relay
// alongside `next dev`, configured entirely through env vars (matching how
// `cairn build` already works) plus an optional `--port` flag.
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema } from "@cairn/core";
import { createRealtimeServer } from "./realtime-server";
import type { CapabilityTier } from "./server";

function parseCapability(raw: string | undefined): CapabilityTier {
  if (raw === "explain" || raw === "guide" || raw === "act") return raw;
  return "act";
}

function parsePortFlag(argv: string[]): number | undefined {
  const idx = argv.indexOf("--port");
  if (idx === -1) return undefined;
  const value = Number(argv[idx + 1]);
  return Number.isFinite(value) ? value : undefined;
}

function main(): void {
  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`cairn-realtime: no ${manifestPath} — run \`cairn build\` first.`);
    process.exit(1);
  }
  const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));

  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) {
    console.error("cairn-realtime: DEEPGRAM_API_KEY is not set.");
    process.exit(1);
  }

  const provider = process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq";
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    console.error("cairn-realtime: ANTHROPIC_API_KEY is not set (CAIRN_RUNTIME_PROVIDER=anthropic).");
    process.exit(1);
  }
  if (provider === "groq" && !process.env.GROQ_API_KEYS) {
    console.error("cairn-realtime: GROQ_API_KEYS is not set (comma-separated).");
    process.exit(1);
  }

  const registeredActions = (process.env.CAIRN_REGISTERED_ACTIONS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const port = parsePortFlag(process.argv.slice(2)) ?? Number(process.env.CAIRN_REALTIME_PORT ?? 3010);
  const capability = parseCapability(process.env.CAIRN_CAPABILITY);
  const persona = process.env.CAIRN_PERSONA || undefined;

  const server = createRealtimeServer({ manifest, provider, deepgramApiKey, registeredActions, capability, persona });
  server.listen(port, () => {
    console.error(`cairn-realtime: listening on ws://localhost:${port} (provider: ${provider})`);
  });
}

main();

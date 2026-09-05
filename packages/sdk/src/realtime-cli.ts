#!/usr/bin/env node
// `cairn-realtime` — zero-code way to run the realtime voice relay
// alongside `next dev`, configured entirely through env vars (matching how
// `cairn build` already works) plus an optional `--port` flag.
//
// `--with "<command>"` is what lets `cairn setup` collapse this into a
// single `npm run dev`, instead of the realtime relay only ever being
// something you remember to start yourself in a second terminal (which,
// found live, is indistinguishable from "voice just doesn't work" —
// nothing in the widget UI hints that a whole separate process needs to
// be running for realtimeUrl to connect to anything). Spawns the given
// shell command as a child alongside the relay; either process exiting
// takes the other down with it, so a crashed `next dev` doesn't leave an
// orphaned relay listening forever, and vice versa.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ManifestSchema } from "@cairnvibe/core";
import { createRealtimeServer } from "./realtime-server";
import { createSqliteMemoryStore } from "./memory-sqlite";
import { createSqliteSkillStore } from "./skill-store";
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

function parseWithFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf("--with");
  return idx === -1 ? undefined : argv[idx + 1];
}

/**
 * Real bug this closes: `--with "next dev"` makes this the *first* process
 * `npm run dev` spawns, a sibling of Next.js, not code running inside it —
 * so it never gets Next's own automatic .env/.env.local loading, and a real
 * key sitting in .env was invisible to it (`process.env.DEEPGRAM_API_KEY`
 * genuinely undefined) even though the exact same key worked fine for
 * Next.js's own API routes a moment later. No new dependency for this —
 * .env is a plain KEY=VALUE format. .env.local loads first (checked second
 * in this list, but a key already set never gets overwritten below) to
 * match Next.js's own precedence; nothing here ever overrides a real,
 * already-set process.env value (a shell export, or a platform like Vercel
 * injecting its own configured env vars) — file contents only ever fill a
 * gap, never win over something actually set.
 */
function loadDotEnv(): void {
  for (const filename of [".env.local", ".env"]) {
    const filePath = path.join(process.cwd(), filename);
    if (!fs.existsSync(filePath)) continue;
    for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function spawnCompanion(command: string): void {
  const child = spawn(command, { shell: true, stdio: "inherit" });
  const shutdown = (code: number | null) => {
    child.kill();
    process.exit(code ?? 0);
  };
  child.on("exit", shutdown);
  process.on("exit", () => child.kill());
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

function main(): void {
  loadDotEnv();
  const withCommand = parseWithFlag(process.argv.slice(2));

  // With --with, this process's real job is running the companion command
  // (`next dev`, typically) — a missing key or an unbuilt manifest should
  // skip *voice specifically*, never take down the whole dev server. Without
  // --with (a bare, deliberate `cairn-realtime` invocation), the old
  // hard-fail-with-a-clear-message behavior is exactly right — there's
  // nothing else this process exists to do.
  const fail = (message: string): never | void => {
    console.error(`cairn-realtime: ${message}`);
    if (withCommand) {
      console.error("cairn-realtime: continuing without voice — starting the companion command anyway.");
      spawnCompanion(withCommand);
      return;
    }
    process.exit(1);
  };

  const manifestPath = path.join(process.cwd(), "ui-manifest.json");
  if (!fs.existsSync(manifestPath)) return fail(`no ${manifestPath} — run \`cairn build\` first.`);
  const manifest = ManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, "utf8")));

  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) return fail("DEEPGRAM_API_KEY is not set.");

  const provider = process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq";
  if (provider === "anthropic" && !process.env.ANTHROPIC_API_KEY) {
    return fail("ANTHROPIC_API_KEY is not set (CAIRN_RUNTIME_PROVIDER=anthropic).");
  }
  if (provider === "groq" && !process.env.GROQ_API_KEYS) {
    return fail("GROQ_API_KEYS is not set (comma-separated).");
  }

  const registeredActions = (process.env.CAIRN_REGISTERED_ACTIONS ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const port = parsePortFlag(process.argv.slice(2)) ?? Number(process.env.CAIRN_REALTIME_PORT ?? 3010);
  const capability = parseCapability(process.env.CAIRN_CAPABILITY);
  const persona = process.env.CAIRN_PERSONA || undefined;

  // Phase 5 / Architecture Pillar 5 — real cross-session memory, opt-in
  // via a real file path. Closes the gap DEVELOPMENT.md's own Pillar 5
  // entry flagged: MemoryStore was wired into createCopilotHandler and
  // ConnectionDeps from the start, but never actually reachable from
  // this CLI — a real deployment had no zero-code way to turn it on for
  // the realtime relay. Absent env var means exactly today's behavior:
  // no memory, zero overhead.
  const memoryDbPath = process.env.CAIRN_MEMORY_DB_PATH;
  const memory = memoryDbPath ? createSqliteMemoryStore(path.resolve(process.cwd(), memoryDbPath)) : undefined;

  // Architecture Pillar 3 (Skill half) — same real, previously-missing
  // wiring for self-authored Skills. Deliberately a SEPARATE file/scope
  // from memory (see skill-store.ts's own doc comment: Skills are
  // per-deployment, memory is per-user) — sharing the same underlying
  // sqlite file is still fine if a deployment points both env vars at
  // the same path, since each store creates its own distinctly-named
  // tables.
  const skillsDbPath = process.env.CAIRN_SKILLS_DB_PATH;
  const skills = skillsDbPath ? createSqliteSkillStore(path.resolve(process.cwd(), skillsDbPath)) : undefined;
  const skillsScopeId = process.env.CAIRN_SKILLS_SCOPE_ID || undefined;

  const server = createRealtimeServer({ manifest, provider, deepgramApiKey, registeredActions, capability, persona, memory, skills, skillsScopeId });
  server.listen(port, () => {
    console.error(`cairn-realtime: listening on ws://localhost:${port} (provider: ${provider})`);
    if (withCommand) spawnCompanion(withCommand);
  });
}

main();

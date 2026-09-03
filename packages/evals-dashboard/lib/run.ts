// Server-only: spawns the real `npm run evals` CLI as a child process and
// captures its output to a log file — the plan's "run trigger" spec ("a
// button to kick off a suite run from the UI, for dev convenience alongside
// the existing CLI"). Deliberately NOT a mock — this runs the exact same
// command a developer would type, so its failure modes (missing API keys,
// a playground app that isn't running) are the real CLI's own, not
// something this dashboard invented.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

function evalsPackageDir(): string {
  return process.env.CAIRN_EVALS_PACKAGE_DIR ?? path.join(process.cwd(), "..", "evals");
}

function logsDir(): string {
  const dir = path.join(process.cwd(), ".run-logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function metaPath(id: string): string {
  return path.join(logsDir(), `${id}.json`);
}

function logPath(id: string): string {
  return path.join(logsDir(), `${id}.log`);
}

export interface RunLogMeta {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

/** Spawns `npm run evals` in packages/evals and returns immediately with a
 * log id — the request that triggers this never waits on the suite run
 * itself, since a real k=3 voice+typed suite can take minutes. */
export function startEvalRun(): string {
  const id = randomUUID();
  const meta: RunLogMeta = { id, startedAt: new Date().toISOString(), finishedAt: null, exitCode: null };
  fs.writeFileSync(metaPath(id), JSON.stringify(meta));

  const out = fs.openSync(logPath(id), "a");
  const child = spawn("npm", ["run", "evals"], {
    cwd: evalsPackageDir(),
    stdio: ["ignore", out, out],
    env: process.env,
  });
  fs.closeSync(out);

  child.on("exit", (code) => {
    const finished: RunLogMeta = { ...meta, finishedAt: new Date().toISOString(), exitCode: code };
    fs.writeFileSync(metaPath(id), JSON.stringify(finished));
  });
  child.on("error", (err) => {
    fs.appendFileSync(logPath(id), `\n[dashboard] failed to spawn: ${err.message}\n`);
    const finished: RunLogMeta = { ...meta, finishedAt: new Date().toISOString(), exitCode: -1 };
    fs.writeFileSync(metaPath(id), JSON.stringify(finished));
  });

  return id;
}

export function readRunLog(id: string): { meta: RunLogMeta; log: string } | null {
  if (!/^[a-f0-9-]{36}$/.test(id) || !fs.existsSync(metaPath(id))) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf8")) as RunLogMeta;
  const log = fs.existsSync(logPath(id)) ? fs.readFileSync(logPath(id), "utf8") : "";
  return { meta, log };
}

export function listRuns(): RunLogMeta[] {
  const dir = logsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as RunLogMeta)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

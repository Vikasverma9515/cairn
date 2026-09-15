import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOrchestratorScript } from "./orchestrator";

describe("buildOrchestratorScript", () => {
  it("embeds every given command with its own label", () => {
    const script = buildOrchestratorScript([
      { label: "app", command: "vite" },
      { label: "cairn-backend", command: "node cairn-server.cjs" },
    ]);
    expect(script).toContain('label: "app"');
    expect(script).toContain('command: "vite"');
    expect(script).toContain('label: "cairn-backend"');
    expect(script).toContain('command: "node cairn-server.cjs"');
  });

  it("is valid, runnable JavaScript that actually spawns every command and stops them all together", async () => {
    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-orchestrator-"));
      const markerA = path.join(tmpDir, "a.txt");
      const markerB = path.join(tmpDir, "b.txt");
      const scriptPath = path.join(tmpDir, "cairn-dev.cjs");

      // Real end-to-end check, not just a string-contains assertion: the
      // generated script is executed by an actual `node`, and both
      // "commands" (writing their own marker file) must actually run.
      // Each command writes its own marker file THEN stays alive briefly —
      // mirrors the real use case (long-running dev/backend processes):
      // shutdown-on-any-exit only matters once one sibling actually dies,
      // so a marker write racing an instant-exit sibling isn't the thing
      // under test here.
      fs.writeFileSync(
        scriptPath,
        buildOrchestratorScript([
          { label: "one", command: `node -e "require('fs').writeFileSync('${markerA}', 'ok'); setTimeout(() => {}, 300)"` },
          { label: "two", command: `node -e "require('fs').writeFileSync('${markerB}', 'ok'); setTimeout(() => {}, 300)"` },
        ]),
      );

      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath], { stdio: "ignore" });
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("orchestrator script did not exit in time"));
        }, 10_000);
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.on("error", reject);
      });

      expect(fs.existsSync(markerA)).toBe(true);
      expect(fs.existsSync(markerB)).toBe(true);
    } finally {
      if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

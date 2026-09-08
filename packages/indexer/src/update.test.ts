import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUpdate } from "./update";

// Same real reason remove.test.ts stubs this: `npm view`/`npm install` are
// real network calls with no reason to actually hit the registry from a
// unit test — these tests are exercising runUpdate's own version-comparison
// and reporting logic, not npm's own behavior.
const execSyncMock = vi.fn();
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: (...args: unknown[]) => execSyncMock(...args) };
});

// Same clack stub shape as remove.test.ts, plus `confirm` — runUpdate's
// own interactive "update now?" prompt, which remove.ts's tests never
// needed.
function fakeSpinner() {
  return { start: vi.fn(), stop: vi.fn(), error: vi.fn(), message: vi.fn(), cancel: vi.fn(), clear: vi.fn(), isCancelled: false };
}
const fakeClackInstance = {
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  log: { step: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), message: vi.fn() },
  spinner: vi.fn(fakeSpinner),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
};
vi.mock("./clack", () => ({ clack: async () => fakeClackInstance }));

describe("runUpdate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-update-"));
    execSyncMock.mockReset();
    fakeClackInstance.confirm.mockReset();
    fakeClackInstance.log.success.mockClear();
    fakeClackInstance.log.warn.mockClear();
    fakeClackInstance.note.mockClear();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeJson(rel: string, data: unknown): void {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  }

  /** Matches an installed package's real node_modules/<pkg>/package.json —
   * the thing runUpdate actually trusts, not the declared range. */
  function installPackage(pkg: string, version: string): void {
    writeJson(path.join("node_modules", pkg, "package.json"), { name: pkg, version });
  }

  function mockNpmView(latestByPackage: Record<string, string>): void {
    execSyncMock.mockImplementation((cmd: string) => {
      const match = /^npm view (\S+) version$/.exec(cmd);
      if (match) {
        const pkg = match[1];
        if (!(pkg in latestByPackage)) throw new Error(`no mocked version for ${pkg}`);
        return Buffer.from(latestByPackage[pkg] + "\n");
      }
      return Buffer.from("");
    });
  }

  it("reports nothing to check when this project declares no @cairnvibe packages at all", async () => {
    writeJson("package.json", { name: "some-other-app", dependencies: {} });
    await runUpdate(tmpDir, { apply: false });
    expect(fakeClackInstance.log.warn).toHaveBeenCalledWith(expect.stringContaining("nothing to check"));
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("reports everything up to date when installed versions already match the latest published ones", async () => {
    writeJson("package.json", { dependencies: { "@cairnvibe/sdk": "^0.4.7" } });
    installPackage("@cairnvibe/sdk", "0.4.7");
    mockNpmView({ "@cairnvibe/sdk": "0.4.7" });

    await runUpdate(tmpDir, { apply: false });

    expect(fakeClackInstance.log.success).toHaveBeenCalledWith("Everything is up to date.");
    // Only the read (npm view), never a write — nothing needed updating.
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("in interactive mode, asks before installing and does nothing if the user declines", async () => {
    writeJson("package.json", { dependencies: { "@cairnvibe/sdk": "^0.4.5" } });
    installPackage("@cairnvibe/sdk", "0.4.5");
    mockNpmView({ "@cairnvibe/sdk": "0.4.7" });
    fakeClackInstance.confirm.mockResolvedValue(false);

    await runUpdate(tmpDir, { apply: false });

    expect(fakeClackInstance.confirm).toHaveBeenCalled();
    // A decline reports the manual command instead of running npm install.
    expect(fakeClackInstance.note).toHaveBeenCalledWith(expect.stringContaining("npm install @cairnvibe/sdk@0.4.7"), expect.any(String));
    expect(execSyncMock).toHaveBeenCalledTimes(1); // only the version check, no install
  });

  it("in interactive mode, installs every outdated package in one npm install call after the user confirms", async () => {
    writeJson("package.json", {
      dependencies: { "@cairnvibe/core": "^0.1.0", "@cairnvibe/sdk": "^0.4.0" },
    });
    installPackage("@cairnvibe/core", "0.1.0");
    installPackage("@cairnvibe/sdk", "0.4.0");
    mockNpmView({ "@cairnvibe/core": "0.1.8", "@cairnvibe/sdk": "0.4.7" });
    fakeClackInstance.confirm.mockResolvedValue(true);

    // After the (mocked) `npm install` "runs," simulate the real upgrade by
    // rewriting the installed package.json files — same real-verification
    // discipline runUpdate itself uses (it re-reads node_modules after
    // installing rather than trusting the command's exit code alone).
    execSyncMock.mockImplementation((cmd: string) => {
      const viewMatch = /^npm view (\S+) version$/.exec(cmd);
      if (viewMatch) {
        const versions: Record<string, string> = { "@cairnvibe/core": "0.1.8", "@cairnvibe/sdk": "0.4.7" };
        return Buffer.from(versions[viewMatch[1]] + "\n");
      }
      if (cmd.startsWith("npm install")) {
        installPackage("@cairnvibe/core", "0.1.8");
        installPackage("@cairnvibe/sdk", "0.4.7");
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    await runUpdate(tmpDir, { apply: false });

    const installCall = execSyncMock.mock.calls.find((c) => String(c[0]).startsWith("npm install"));
    expect(installCall).toBeDefined();
    const installCmd = String(installCall![0]);
    expect(installCmd).toContain("@cairnvibe/core@0.1.8");
    expect(installCmd).toContain("@cairnvibe/sdk@0.4.7");
    expect(fakeClackInstance.log.success).toHaveBeenCalledWith(expect.stringContaining("@cairnvibe/core  now at 0.1.8"));
  });

  it("with --apply, installs immediately without asking for confirmation", async () => {
    writeJson("package.json", { dependencies: { "@cairnvibe/sdk": "^0.4.0" } });
    installPackage("@cairnvibe/sdk", "0.4.0");
    execSyncMock.mockImplementation((cmd: string) => {
      if (/^npm view/.test(cmd)) return Buffer.from("0.4.7\n");
      if (cmd.startsWith("npm install")) {
        installPackage("@cairnvibe/sdk", "0.4.7");
        return Buffer.from("");
      }
      return Buffer.from("");
    });

    await runUpdate(tmpDir, { apply: true });

    expect(fakeClackInstance.confirm).not.toHaveBeenCalled();
    expect(execSyncMock.mock.calls.some((c) => String(c[0]).startsWith("npm install"))).toBe(true);
  });

  it("reports a package as not installed (rather than crashing) when only declared in package.json", async () => {
    writeJson("package.json", { dependencies: { "@cairnvibe/sdk": "^0.4.0" } });
    // Deliberately no node_modules/@cairnvibe/sdk written.
    mockNpmView({ "@cairnvibe/sdk": "0.4.7" });
    fakeClackInstance.confirm.mockResolvedValue(false);

    await runUpdate(tmpDir, { apply: false });

    expect(fakeClackInstance.note).toHaveBeenCalledWith(expect.stringContaining("@cairnvibe/sdk  not installed (latest is 0.4.7)"), expect.any(String));
  });

  it("degrades gracefully when the registry lookup itself fails (offline)", async () => {
    writeJson("package.json", { dependencies: { "@cairnvibe/sdk": "^0.4.7" } });
    installPackage("@cairnvibe/sdk", "0.4.7");
    execSyncMock.mockImplementation(() => {
      throw new Error("network unreachable");
    });

    await runUpdate(tmpDir, { apply: false });

    expect(fakeClackInstance.note).toHaveBeenCalledWith(expect.stringContaining("couldn't reach npm"), expect.any(String));
    // Nothing to confirm/install when the latest version couldn't even be determined.
    expect(fakeClackInstance.confirm).not.toHaveBeenCalled();
  });
});

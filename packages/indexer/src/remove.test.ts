import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRemove } from "./remove";
import { writeInstallManifest, readInstallManifest, type InstallManifest } from "./install-manifest";
import { installManifestPath, CAIRN_DIR } from "./cairn-dir";

// npm uninstall is real network/filesystem work with no reason to actually
// run against a fixture project that was never really `npm install`ed —
// every other real npm-touching path in this package (setup.ts's own
// install step) is exercised live only through cairn setup itself, never
// through a unit test. Stubbed here the same way, so these tests verify
// runRemove's own file/config reversal logic — the actual point of this
// feature — without needing a real node_modules tree.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execSync: vi.fn() };
});

describe("runRemove", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-remove-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    return p;
  }

  /** A realistic full install-manifest, matching what runSetup actually
   * assembles for a voice-enabled App Router project — used as the
   * baseline every test in this file starts from and tweaks. */
  function fullFixture(): { manifest: InstallManifest; layout: string; wrapper: string; config: string; pkgPath: string } {
    const route = write("app/api/copilot/route.ts", "// generated route\n");
    const speak = write("app/api/copilot/speak/route.ts", "// generated speak route\n");
    const transcribe = write("app/api/copilot/transcribe/route.ts", "// generated transcribe route\n");
    const envExample = write(path.join(CAIRN_DIR, ".env.example"), "ANTHROPIC_API_KEY=\n");
    const manifestJson = write(path.join(CAIRN_DIR, "ui-manifest.json"), '{"version":"1"}');

    const layout = write(
      "app/layout.tsx",
      `import { CairnCopilot } from "../components/CairnCopilot";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <CairnCopilot />
      </body>
    </html>
  );
}
`,
    );
    const wrapper = write(
      "components/CairnCopilot.tsx",
      `"use client";
import { Copilot } from "@cairnvibe/sdk";
export function CairnCopilot() {
  return <Copilot registeredActions={[]} onDo={() => {}} />;
}
`,
    );
    const config = write(
      "next.config.js",
      `module.exports = {
  reactStrictMode: true,
  transpilePackages: ["some-other-package", "@cairnvibe/sdk", "@cairnvibe/core"],
};
`,
    );
    const pkgPath = write(
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          scripts: {
            dev: 'cairn-realtime --port 3010 --with "next dev"',
            build: "next build",
            prebuild: "cairn build . --provider anthropic --if-configured",
          },
          dependencies: { next: "14.2.0", "@cairnvibe/core": "^0.1.8", "@cairnvibe/sdk": "^0.4.1" },
        },
        null,
        2,
      ),
    );
    write(".env", "ANTHROPIC_API_KEY=sk-real-secret-key\nCAIRN_REGISTERED_ACTIONS=\n");

    const manifest: InstallManifest = {
      installedAt: new Date().toISOString(),
      filesCreated: [route, speak, transcribe, envExample, manifestJson, wrapper],
      layoutFile: layout,
      wrapperFile: wrapper,
      configFile: { path: config, created: false },
      originalDevScript: "next dev",
      prebuildScriptAdded: true,
      packagesInstalled: ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"],
    };
    writeInstallManifest(tmpDir, manifest);

    return { manifest, layout, wrapper, config, pkgPath };
  }

  it("does nothing and says so when there's no install-manifest at all — not a cairn-setup-managed project", async () => {
    write("app/layout.tsx", "export default function L() { return null; }\n");

    await runRemove(tmpDir);

    // nothing it might have touched changed
    expect(fs.readFileSync(path.join(tmpDir, "app/layout.tsx"), "utf8")).toContain("export default function L");
  });

  it("removes every file it created outright", async () => {
    const { manifest } = fullFixture();

    await runRemove(tmpDir);

    for (const f of manifest.filesCreated) {
      expect(fs.existsSync(f)).toBe(false);
    }
  });

  it("removes the widget from the layout file precisely, without touching the rest of it", async () => {
    const { layout } = fullFixture();

    await runRemove(tmpDir);

    const text = fs.readFileSync(layout, "utf8");
    expect(text).not.toContain("CairnCopilot");
    expect(text).toContain("{children}");
    expect(text).toContain("<html");
  });

  it("strips only the two cairnvibe entries from an existing next.config.js, preserving everything else", async () => {
    const { config } = fullFixture();

    await runRemove(tmpDir);

    const text = fs.readFileSync(config, "utf8");
    expect(text).not.toContain("@cairnvibe/sdk");
    expect(text).not.toContain("@cairnvibe/core");
    expect(text).toContain("some-other-package");
    expect(text).toContain("reactStrictMode: true");
  });

  it("restores the original dev script and removes the prebuild script it added", async () => {
    const { pkgPath } = fullFixture();

    await runRemove(tmpDir);

    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    expect(pkg.scripts.dev).toBe("next dev");
    expect(pkg.scripts.prebuild).toBeUndefined();
    expect(pkg.scripts.build).toBe("next build"); // untouched
  });

  it("never touches .env — real credentials survive a remove untouched, byte for byte", async () => {
    fullFixture();
    const envPath = path.join(tmpDir, ".env");
    const before = fs.readFileSync(envPath, "utf8");

    await runRemove(tmpDir);

    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, "utf8")).toBe(before);
  });

  it("deletes .cairn/ itself, including the install-manifest it just read", async () => {
    fullFixture();
    expect(fs.existsSync(installManifestPath(tmpDir))).toBe(true);

    await runRemove(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, CAIRN_DIR))).toBe(false);
  });

  it("uninstalls the recorded packages via a real npm uninstall invocation", async () => {
    fullFixture();
    const { execSync } = await import("node:child_process");

    await runRemove(tmpDir);

    expect(execSync).toHaveBeenCalledWith(
      "npm uninstall @cairnvibe/core @cairnvibe/sdk @cairnvibe/indexer",
      expect.objectContaining({ cwd: tmpDir }),
    );
  });

  it("is safe to run when files it recorded were already deleted by hand — skips them instead of throwing", async () => {
    const { manifest, layout } = fullFixture();
    fs.rmSync(manifest.filesCreated[0]); // delete one of the tracked files ahead of time

    await expect(runRemove(tmpDir)).resolves.not.toThrow();
    expect(fs.existsSync(layout)).toBe(true); // the rest of removal still ran
    expect(fs.readFileSync(layout, "utf8")).not.toContain("CairnCopilot");
  });

  it("leaves package.json scripts alone entirely when voice was never set up (no dev rewrite, no prebuild)", async () => {
    const route = write("app/api/copilot/route.ts", "// generated\n");
    const pkgPath = write(
      "package.json",
      JSON.stringify({ name: "fixture", scripts: { dev: "next dev", build: "next build" } }, null, 2),
    );
    const manifest: InstallManifest = {
      installedAt: new Date().toISOString(),
      filesCreated: [route],
      layoutFile: null,
      wrapperFile: null,
      configFile: null,
      originalDevScript: null,
      prebuildScriptAdded: false,
      packagesInstalled: ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"],
    };
    writeInstallManifest(tmpDir, manifest);
    const before = fs.readFileSync(pkgPath, "utf8");

    await runRemove(tmpDir);

    expect(fs.readFileSync(pkgPath, "utf8")).toBe(before);
  });
});

describe("install-manifest read/write round trip", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-install-manifest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips every field exactly", () => {
    const manifest: InstallManifest = {
      installedAt: "2026-01-01T00:00:00.000Z",
      filesCreated: ["/a/b.ts", "/a/c.ts"],
      layoutFile: "/a/layout.tsx",
      wrapperFile: "/a/components/CairnCopilot.tsx",
      configFile: { path: "/a/next.config.js", created: true },
      originalDevScript: "next dev",
      prebuildScriptAdded: true,
      packagesInstalled: ["@cairnvibe/core", "@cairnvibe/sdk", "@cairnvibe/indexer"],
    };

    writeInstallManifest(tmpDir, manifest);
    const read = readInstallManifest(tmpDir);

    expect(read).toEqual(manifest);
  });

  it("returns null when nothing was ever written", () => {
    expect(readInstallManifest(tmpDir)).toBeNull();
  });
});

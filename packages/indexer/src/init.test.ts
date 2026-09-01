import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInit } from "./init";

describe("runInit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-init-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("detects Next.js App Router from package.json's next dependency + an app/ directory", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));
    fs.mkdirSync(path.join(tmpDir, "app"));

    const result = runInit(tmpDir);

    expect(result.framework).toBe("next-app-router");
    expect(fs.existsSync(path.join(tmpDir, "app", "api", "copilot", "route.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "pages", "api", "copilot.ts"))).toBe(false);
  });

  it("detects Next.js Pages Router when next is a dependency but there's no app/ directory", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));

    const result = runInit(tmpDir);

    expect(result.framework).toBe("next-pages-router");
    expect(fs.existsSync(path.join(tmpDir, "pages", "api", "copilot.ts"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "app", "api", "copilot", "route.ts"))).toBe(false);
  });

  it("falls back to the standalone Express scaffold when next isn't a dependency", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: {} }));

    const result = runInit(tmpDir);

    expect(result.framework).toBe("other");
    expect(fs.existsSync(path.join(tmpDir, "cairn-server.cjs"))).toBe(true);
  });

  it("falls back to the standalone scaffold when there's no package.json at all", () => {
    const result = runInit(tmpDir);
    expect(result.framework).toBe("other");
    expect(fs.existsSync(path.join(tmpDir, "cairn-server.cjs"))).toBe(true);
  });

  it("falls back to the standalone scaffold when package.json is malformed, instead of crashing", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ not valid json");
    expect(() => runInit(tmpDir)).not.toThrow();
    expect(runInit(tmpDir).framework).toBe("other");
  });

  it("always writes a .env.example, regardless of framework", () => {
    const result = runInit(tmpDir);
    expect(fs.existsSync(path.join(tmpDir, ".env.example"))).toBe(true);
    expect(result.filesWritten).toContain(path.join(tmpDir, ".env.example"));
  });

  it("never overwrites a file that already exists — reports it as skipped instead", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: {} }));
    const existing = path.join(tmpDir, "cairn-server.cjs");
    fs.writeFileSync(existing, "// the user's own hand-edited version, do not touch");

    const result = runInit(tmpDir);

    expect(fs.readFileSync(existing, "utf8")).toBe("// the user's own hand-edited version, do not touch");
    expect(result.filesSkipped).toContain(existing);
    expect(result.filesWritten).not.toContain(existing);
  });

  it("the generated Express scaffold is syntactically valid JS (compiles under Node's CJS parser)", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: {} }));
    runInit(tmpDir);
    const src = fs.readFileSync(path.join(tmpDir, "cairn-server.cjs"), "utf8");
    // new Function(...) throws a SyntaxError on invalid JS without executing
    // the module-level require()s (which would fail — express isn't
    // installed in this test's tmpDir) — a parse-only check.
    expect(() => new Function(src)).not.toThrow();
  });

  it("the generated Next.js App Router route is syntactically plausible TypeScript (has the expected exports and imports)", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));
    fs.mkdirSync(path.join(tmpDir, "app"));
    runInit(tmpDir);
    const src = fs.readFileSync(path.join(tmpDir, "app", "api", "copilot", "route.ts"), "utf8");
    expect(src).toContain("export async function POST(");
    expect(src).toContain("createCopilotHandler");
    expect(src).toContain("@cairnvibe/sdk/server");
  });

  it("gives Next.js next steps that mention the widget import and Pages/App-appropriate mount point", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ dependencies: { next: "14.2.0" } }));
    fs.mkdirSync(path.join(tmpDir, "app"));
    const result = runInit(tmpDir);
    expect(result.nextSteps.join("\n")).toContain("@cairnvibe/sdk");
    expect(result.nextSteps.join("\n")).toContain("layout.tsx");
  });
});

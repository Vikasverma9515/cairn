import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureTranspilePackages } from "./ensure-transpile";

describe("ensureTranspilePackages", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-transpile-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function write(rel: string, content: string): string {
    const p = path.join(tmpDir, rel);
    fs.writeFileSync(p, content);
    return p;
  }

  it("adds transpilePackages to a real-world `const nextConfig: NextConfig = {...}; export default nextConfig;` shape", () => {
    // The exact pattern that failed live: Next.js 16 + Turbopack refused
    // to load @cairnvibe/sdk's raw .tsx entry ("Unknown module type") in a
    // real project whose next.config.ts had no transpilePackages at all.
    const config = write(
      "next.config.ts",
      `import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
};

export default nextConfig;
`,
    );

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(true);
    expect(result.filePath).toBe(config);
    const text = fs.readFileSync(config, "utf8");
    expect(text).toContain('"@cairnvibe/sdk"');
    expect(text).toContain('"@cairnvibe/core"');
    expect(text).toContain("reactStrictMode: true"); // existing config untouched
  });

  it("handles `module.exports = nextConfig` (plain JS)", () => {
    const config = write(
      "next.config.js",
      `const nextConfig = {
  reactStrictMode: true,
};
module.exports = nextConfig;
`,
    );

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(true);
    const text = fs.readFileSync(config, "utf8");
    expect(text).toContain('"@cairnvibe/sdk"');
  });

  it("handles a plain `export default {...}` with no intermediate variable", () => {
    write("next.config.mjs", `export default {\n  reactStrictMode: true,\n};\n`);

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "next.config.mjs"), "utf8")).toContain('"@cairnvibe/sdk"');
  });

  it("adds only the missing package when transpilePackages already exists with one of the two", () => {
    write(
      "next.config.js",
      `module.exports = {
  transpilePackages: ["@cairnvibe/sdk", "some-other-package"],
};
`,
    );

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(true);
    const text = fs.readFileSync(path.join(tmpDir, "next.config.js"), "utf8");
    expect(text).toContain("some-other-package"); // preserved
    expect((text.match(/@cairnvibe\/sdk/g) ?? []).length).toBe(1); // not duplicated
    expect(text).toContain("@cairnvibe/core"); // the missing one got added
  });

  it("does nothing when both packages are already listed", () => {
    const original = `module.exports = {\n  transpilePackages: ["@cairnvibe/sdk", "@cairnvibe/core"],\n};\n`;
    const config = write("next.config.js", original);

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already lists these packages/);
    expect(fs.readFileSync(config, "utf8")).toBe(original); // byte-for-byte untouched
  });

  it("creates a new next.config.mjs when no config file exists at all", () => {
    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(true);
    expect(result.created).toBe(true);
    const text = fs.readFileSync(path.join(tmpDir, "next.config.mjs"), "utf8");
    expect(text).toContain('"@cairnvibe/sdk"');
    expect(text).toContain("export default nextConfig");
  });

  it("safely declines — and leaves the file untouched — when the config is wrapped in a plugin function call", () => {
    const original = `const withBundleAnalyzer = require("@next/bundle-analyzer")({ enabled: true });
module.exports = withBundleAnalyzer({
  reactStrictMode: true,
});
`;
    const config = write("next.config.js", original);

    const result = ensureTranspilePackages(tmpDir);

    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/couldn't confidently find/);
    expect(fs.readFileSync(config, "utf8")).toBe(original); // never guesses, never corrupts
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectWidget } from "./inject-widget";

describe("injectWidget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-inject-"));
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

  it("inserts the widget right before </body> in a standard App Router layout", () => {
    const layout = write(
      "app/layout.tsx",
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );

    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(true);
    expect(result.filePath).toBe(layout);
    const text = fs.readFileSync(layout, "utf8");
    expect(text).toContain('import { Copilot } from "@cairnvibe/sdk";');
    expect(text).toContain("<Copilot");
    // still one <html> wrapping one <body> — nothing structurally duplicated or broken
    expect(text.match(/<html/g)).toHaveLength(1);
    expect(text.match(/<\/body>/g)).toHaveLength(1);
  });

  it("falls back to inserting after {children} when there's no literal <body> (a custom Providers wrapper)", () => {
    const layout = write(
      "app/layout.tsx",
      `import { Providers } from "./providers";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <Providers>
      {children}
    </Providers>
  );
}
`,
    );

    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(true);
    const text = fs.readFileSync(layout, "utf8");
    expect(text).toContain("<Copilot");
    expect(text.indexOf("{children}")).toBeLessThan(text.indexOf("<Copilot"));
  });

  it("wraps <Component .../> in a fragment for a Pages Router _app.tsx", () => {
    const app = write(
      "pages/_app.tsx",
      `import type { AppProps } from "next/app";

export default function App({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
`,
    );

    const result = injectWidget(tmpDir, "next-pages-router");

    expect(result.injected).toBe(true);
    const text = fs.readFileSync(app, "utf8");
    expect(text).toContain("<Component {...pageProps} />");
    expect(text).toContain("<Copilot");
    expect(text).toMatch(/<>[\s\S]*<Component[\s\S]*<Copilot[\s\S]*<\/>/);
  });

  it("does nothing and reports why when no layout file exists", () => {
    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/no app\/layout/);
  });

  it("is idempotent — a file that already references Copilot is left untouched", () => {
    const layout = write(
      "app/layout.tsx",
      `import { Copilot } from "@cairnvibe/sdk";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Copilot registeredActions={[]} onDo={() => {}} />
      </body>
    </html>
  );
}
`,
    );
    const before = fs.readFileSync(layout, "utf8");

    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/already references Copilot/);
    expect(fs.readFileSync(layout, "utf8")).toBe(before); // byte-for-byte untouched
  });

  it("running it twice in a row never double-injects", () => {
    write(
      "app/layout.tsx",
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    );

    const first = injectWidget(tmpDir, "next-app-router");
    const second = injectWidget(tmpDir, "next-app-router");

    expect(first.injected).toBe(true);
    expect(second.injected).toBe(false);
    const text = fs.readFileSync(path.join(tmpDir, "app/layout.tsx"), "utf8");
    expect(text.match(/<Copilot/g)).toHaveLength(1);
  });

  it("leaves the original file completely untouched when it can't find a safe insertion point", () => {
    const layout = write(
      "app/layout.tsx",
      `// no <body>, no {children}, no <Component/> — nothing this module knows how to target
export const notAComponent = 1;
`,
    );
    const before = fs.readFileSync(layout, "utf8");

    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(false);
    expect(fs.readFileSync(layout, "utf8")).toBe(before);
  });
});

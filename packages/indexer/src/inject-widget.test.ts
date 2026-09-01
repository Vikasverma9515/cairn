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

  it("inserts <CairnCopilot/> right before </body>, and generates a real client-component wrapper", () => {
    // Real bug this guards: an earlier version inserted <Copilot
    // onDo={...}/> straight into the layout file. App Router layouts are
    // Server Components by default, and React Server Components reject a
    // plain inline function passed as a prop to a Client Component
    // ("Event handlers cannot be passed to Client Component props") —
    // found live against a real project, not a synthetic case. The fix
    // is the same shape the one real working example in this repo
    // already uses (examples/demo-app/components/CopilotWithActions.tsx):
    // a small "use client" wrapper that defines onDo itself, referenced
    // from the layout with zero function props.
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
    expect(result.wrapperPath).toBe(path.join(tmpDir, "components", "CairnCopilot.tsx"));

    const layoutText = fs.readFileSync(layout, "utf8");
    expect(layoutText).toContain('import { CairnCopilot } from "../components/CairnCopilot";');
    expect(layoutText).toContain("<CairnCopilot />");
    expect(layoutText).not.toContain("onDo"); // no function prop in the server-component file
    // still one <html> wrapping one <body> — nothing structurally duplicated or broken
    expect(layoutText.match(/<html/g)).toHaveLength(1);
    expect(layoutText.match(/<\/body>/g)).toHaveLength(1);

    const wrapperText = fs.readFileSync(result.wrapperPath!, "utf8");
    expect(wrapperText.startsWith('"use client";')).toBe(true);
    expect(wrapperText).toContain('import { Copilot } from "@cairnvibe/sdk";');
    expect(wrapperText).toContain("onDo=");
  });

  it("does not pass speakEndpoint/transcribeEndpoint by default — voice is opt-in", () => {
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

    const result = injectWidget(tmpDir, "next-app-router");

    const wrapperText = fs.readFileSync(result.wrapperPath!, "utf8");
    expect(wrapperText).not.toContain("speakEndpoint");
    expect(wrapperText).not.toContain("transcribeEndpoint");
  });

  it("wires speakEndpoint/transcribeEndpoint into the wrapper when voice is requested", () => {
    // Real bug this guards: the wrapper used to never pass these props at
    // all, so the widget had no way to know voice existed even when a
    // valid DEEPGRAM_API_KEY was configured and the backend routes existed.
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

    const result = injectWidget(tmpDir, "next-app-router", { voice: true });

    const wrapperText = fs.readFileSync(result.wrapperPath!, "utf8");
    expect(wrapperText).toContain('speakEndpoint="/api/copilot/speak"');
    expect(wrapperText).toContain('transcribeEndpoint="/api/copilot/transcribe"');
    expect(wrapperText).toContain('realtimeUrl="ws://localhost:3010"');
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
    expect(text).toContain("<CairnCopilot />");
    expect(text.indexOf("{children}")).toBeLessThan(text.indexOf("<CairnCopilot"));
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
    expect(text).toContain("<CairnCopilot />");
    expect(text).toMatch(/<>[\s\S]*<Component[\s\S]*<CairnCopilot[\s\S]*<\/>/);
  });

  it("does nothing and reports why when no layout file exists", () => {
    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/no app\/layout/);
  });

  it("is idempotent — a file already wired by a previous run is left untouched", () => {
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
    const before = fs.readFileSync(layout, "utf8");

    const result = injectWidget(tmpDir, "next-app-router");

    expect(result.injected).toBe(false);
    expect(result.reason).toMatch(/already references the widget/);
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
    expect(text.match(/<CairnCopilot/g)).toHaveLength(1);
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

  it("matches the .jsx extension of a plain-JS layout instead of always writing .tsx", () => {
    write(
      "app/layout.jsx",
      `export default function RootLayout({ children }) {
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
    expect(result.wrapperPath).toBe(path.join(tmpDir, "components", "CairnCopilot.jsx"));
    expect(fs.existsSync(path.join(tmpDir, "components", "CairnCopilot.jsx"))).toBe(true);
  });
});

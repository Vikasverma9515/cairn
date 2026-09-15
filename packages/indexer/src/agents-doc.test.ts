import { describe, expect, it } from "vitest";
import { buildCairnAgentsDoc } from "./agents-doc";

describe("buildCairnAgentsDoc", () => {
  it("describes the standalone-backend path for a non-Next project, with real ports and file names", () => {
    const doc = buildCairnAgentsDoc({
      framework: "other",
      voice: true,
      provider: "groq",
      packageVersion: "0.5.0",
      standaloneApiPort: 4000,
      realtimePort: 3010,
    });
    expect(doc).toContain("cairn-server.cjs");
    expect(doc).toContain("http://localhost:4000");
    expect(doc).toContain("ws://localhost:3010");
    expect(doc).toContain("cairn-widget.js");
    expect(doc).toContain("Current provider on this install: **groq**");
    expect(doc).toContain("DEEPGRAM_API_KEY");
    expect(doc).not.toContain("app/api/copilot/route.ts");
  });

  it("describes the in-process Next.js App Router path when voice is off, without a realtime section", () => {
    const doc = buildCairnAgentsDoc({
      framework: "next-app-router",
      voice: false,
      provider: "anthropic",
      packageVersion: "0.5.0",
    });
    expect(doc).toContain("app/api/copilot/route.ts");
    expect(doc).toContain("Next.js App Router");
    expect(doc).not.toContain("cairn-server.cjs");
    expect(doc).toContain('Re-run `npx cairn setup` and choose "Set up voice now."');
  });

  it("describes the Pages Router path distinctly from App Router", () => {
    const doc = buildCairnAgentsDoc({ framework: "next-pages-router", voice: false, provider: null, packageVersion: "0.5.0" });
    expect(doc).toContain("pages/api/copilot.ts");
    expect(doc).toContain("Next.js Pages Router");
    expect(doc).toContain("Current provider on this install: **not set — add one to .env**");
  });

  it("always points at the real upstream repo for deeper bugfixing", () => {
    const doc = buildCairnAgentsDoc({ framework: "other", voice: false, provider: null, packageVersion: "0.5.0" });
    expect(doc).toContain("https://github.com/Vikasverma9515/cairn");
    expect(doc).toContain("packages/sdk/src/server.ts");
    expect(doc).toContain("npx cairn remove");
  });
});

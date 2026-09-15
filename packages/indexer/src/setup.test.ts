import { describe, expect, it } from "vitest";
import { buildEnvLines } from "./setup";

describe("buildEnvLines", () => {
  it("writes CAIRN_RUNTIME_PROVIDER alongside the chosen provider's key — regression guard for the real bug where choosing Gemini/Anthropic silently did nothing", () => {
    // Real, live-found: every generated backend template defaults to
    // "groq" unless CAIRN_RUNTIME_PROVIDER is set. Without this line, a
    // real install with Gemini chosen and a real Gemini key configured
    // still failed every request, because the runtime never knew to
    // actually use it.
    const lines = buildEnvLines("gemini", "real-gemini-key", null);
    expect(lines).toContain("GEMINI_API_KEY=real-gemini-key");
    expect(lines).toContain("CAIRN_RUNTIME_PROVIDER=gemini");
    expect(lines.join("\n")).not.toContain("GROQ_API_KEYS");
  });

  it("does the same for anthropic", () => {
    const lines = buildEnvLines("anthropic", "sk-ant-real", null);
    expect(lines).toContain("ANTHROPIC_API_KEY=sk-ant-real");
    expect(lines).toContain("CAIRN_RUNTIME_PROVIDER=anthropic");
  });

  it("does the same for groq (the default the bug always fell back to, so this must keep working)", () => {
    const lines = buildEnvLines("groq", "gsk_real", null);
    expect(lines).toContain("GROQ_API_KEYS=gsk_real");
    expect(lines).toContain("CAIRN_RUNTIME_PROVIDER=groq");
  });

  it("writes no provider key or CAIRN_RUNTIME_PROVIDER line when the provider was skipped", () => {
    const lines = buildEnvLines(null, null, null);
    expect(lines.some((l) => l.startsWith("CAIRN_RUNTIME_PROVIDER"))).toBe(false);
    expect(lines.some((l) => l.includes("API_KEY="))).toBe(false);
  });

  it("includes DEEPGRAM_API_KEY only when voice was actually set up", () => {
    expect(buildEnvLines("groq", "gsk_real", "dg_real")).toContain("DEEPGRAM_API_KEY=dg_real");
    expect(buildEnvLines("groq", "gsk_real", null).some((l) => l.startsWith("DEEPGRAM_API_KEY"))).toBe(false);
  });

  it("always ends with an empty CAIRN_REGISTERED_ACTIONS line", () => {
    expect(buildEnvLines(null, null, null)).toContain("CAIRN_REGISTERED_ACTIONS=");
  });
});

import { describe, expect, it, vi } from "vitest";

// Real, live-found bug this guards: `npx cairn build <url>` (crawl mode)
// failed on a real cloned project's first run with Playwright's own
// generic "Executable doesn't exist... run npx playwright install"
// message — no Cairn context, easy to mistake for a broken install.
// launchChromium() wraps that one specific failure mode with a clear,
// actionable message while leaving every other launch failure untouched.
vi.mock("playwright", () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

describe("launchChromium", () => {
  it("wraps Playwright's missing-browser-binary error with a clear, actionable message", async () => {
    const { chromium } = await import("playwright");
    (chromium.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error(
        "browserType.launch: Executable doesn't exist at /Users/x/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell\n" +
          "╔═══════════════════════════════════════╗\n║ Looks like Playwright was just installed or updated. ║\n╚═══════════════════════════════════════╝",
      ),
    );
    const { launchChromium } = await import("./crawl");

    await expect(launchChromium()).rejects.toThrow("npx playwright install chromium");
  });

  it("leaves an unrelated launch failure untouched", async () => {
    const { chromium } = await import("playwright");
    (chromium.launch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("some other real launch failure"));
    const { launchChromium } = await import("./crawl");

    await expect(launchChromium()).rejects.toThrow("some other real launch failure");
  });
});

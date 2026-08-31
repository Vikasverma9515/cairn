import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanL1 } from "./l1-scan";
import { describeAll } from "./l3-describe";
import type { DescribeClient, DescribeInput, PageDescription } from "./llm";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../fixtures/simple-app");

class FakeClient implements DescribeClient {
  calls = 0;
  async describePage(input: DescribeInput): Promise<PageDescription> {
    this.calls += 1;
    return {
      title: input.route,
      purpose: `Fake purpose for ${input.route}`,
      whenToUse: "Fake whenToUse",
      confidence: 0.9,
      elements: input.elements.map((e) => ({ id: e.id, does: `Fake does for ${e.id}`, confidence: 0.9 })),
    };
  }
}

describe("describeAll", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-l3-"));
    fs.cpSync(FIXTURE, tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("calls the client once per page on a cold run and writes the cache", async () => {
    const facts = scanL1(tmpDir);
    const client = new FakeClient();
    const result = await describeAll(tmpDir, facts, client);

    expect(client.calls).toBe(facts.pages.length);
    expect(result.cacheMisses).toBe(facts.pages.length);
    expect(result.cacheHits).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, ".cairn-cache"))).toBe(true);
  });

  it("hits the cache on a warm run with unchanged source — no LLM calls", async () => {
    const facts = scanL1(tmpDir);
    await describeAll(tmpDir, facts, new FakeClient());

    const warmClient = new FakeClient();
    const result = await describeAll(tmpDir, facts, warmClient);

    expect(warmClient.calls).toBe(0);
    expect(result.cacheHits).toBe(facts.pages.length);
  });

  it("invalidates only the cache entry for a page whose source changed", async () => {
    const facts = scanL1(tmpDir);
    await describeAll(tmpDir, facts, new FakeClient());

    // Touch only the about page's content.
    const aboutFile = path.join(tmpDir, "app/about/page.tsx");
    fs.writeFileSync(aboutFile, fs.readFileSync(aboutFile, "utf8") + "\n// changed\n");

    const factsAfterEdit = scanL1(tmpDir);
    const client = new FakeClient();
    const result = await describeAll(tmpDir, factsAfterEdit, client);

    expect(client.calls).toBe(1); // only the about page re-described
    expect(result.cacheHits).toBe(factsAfterEdit.pages.length - 1);
    expect(result.cacheMisses).toBe(1);
  });

  it("describes framework-level elements (e.g. a layout nav link) once, cached separately from pages", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "app/layout.tsx"),
      `export default function RootLayout({ children }: { children: React.ReactNode }) {
        return (
          <html>
            <body>
              <a href="/about" data-ai="nav-about">About</a>
              {children}
            </body>
          </html>
        );
      }`,
    );

    const facts = scanL1(tmpDir);
    expect(facts.frameworkElements.length).toBeGreaterThan(0);

    const client = new FakeClient();
    const coldResult = await describeAll(tmpDir, facts, client);
    const coldCalls = client.calls;
    expect(coldResult.globalElements.find((e) => e.id === "nav-about")).toBeDefined();

    const warmClient = new FakeClient();
    const warmResult = await describeAll(tmpDir, facts, warmClient);
    expect(warmClient.calls).toBe(0); // global elements cache hit too
    expect(warmResult.globalElements).toEqual(coldResult.globalElements);
    expect(coldCalls).toBe(facts.pages.length + 1); // +1 for the one global-elements call
  });

  it("one page's description failing degrades only that page — the whole build still completes", async () => {
    const facts = scanL1(tmpDir);
    expect(facts.pages.length).toBeGreaterThan(1); // otherwise this test doesn't prove anything about "other pages unaffected"
    const failingRoute = facts.pages[0].route;

    class PartiallyFailingClient implements DescribeClient {
      async describePage(input: DescribeInput): Promise<PageDescription> {
        if (input.route === failingRoute) {
          throw new Error("simulated non-retryable failure"); // no .status -> withRetry gives up immediately, keeps this test fast
        }
        return {
          title: input.route,
          purpose: `Fake purpose for ${input.route}`,
          whenToUse: "Fake whenToUse",
          confidence: 0.9,
          elements: input.elements.map((e) => ({ id: e.id, does: `Fake does for ${e.id}`, confidence: 0.9 })),
        };
      }
    }

    const result = await describeAll(tmpDir, facts, new PartiallyFailingClient());

    const failed = result.descriptions.get(failingRoute)!;
    expect(failed.confidence).toBe(0);
    expect(failed.title).toBe("(description unavailable)");

    for (const page of facts.pages) {
      if (page.route === failingRoute) continue;
      expect(result.descriptions.get(page.route)?.confidence).toBe(0.9); // every other page still described normally
    }
  });

  it("a degraded page is never cached — a later run retries it instead of staying permanently stuck", async () => {
    const facts = scanL1(tmpDir);
    const failingRoute = facts.pages[0].route;
    let attempts = 0;

    class FlakyOnceClient implements DescribeClient {
      async describePage(input: DescribeInput): Promise<PageDescription> {
        if (input.route === failingRoute) {
          attempts += 1;
          if (attempts === 1) throw new Error("simulated failure, first attempt only");
        }
        return {
          title: input.route,
          purpose: `Fake purpose for ${input.route}`,
          whenToUse: "Fake whenToUse",
          confidence: 0.9,
          elements: input.elements.map((e) => ({ id: e.id, does: `Fake does for ${e.id}`, confidence: 0.9 })),
        };
      }
    }

    const client = new FlakyOnceClient();
    const firstRun = await describeAll(tmpDir, facts, client);
    expect(firstRun.descriptions.get(failingRoute)?.confidence).toBe(0); // degraded — not cached

    const secondRun = await describeAll(tmpDir, facts, client); // same client, same tmpDir/cache — nothing about the source changed
    expect(secondRun.descriptions.get(failingRoute)?.confidence).toBe(0.9); // retried for real and succeeded, not stuck replaying the old failure
    expect(attempts).toBe(2); // called again on the second run — proves no cache file was written for the failed attempt
  });
});

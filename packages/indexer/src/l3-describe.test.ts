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
});

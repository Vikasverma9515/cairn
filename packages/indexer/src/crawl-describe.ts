// Crawl mode's equivalent of l3-describe.ts's describeAll — same LLM
// description step, same content-hash caching (a warm build with no
// change in what was crawled never re-calls the model), but hashing the
// crawled page's rendered text + elements instead of reading source off
// disk (crawl mode has no source file — see types.ts's RawPage.renderedText).

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RawElement, RawFacts } from "./types";
import type { DescribeClient } from "./llm";
import type { L3Result } from "./l3-describe";

const CACHE_DIR = ".cairn-cache";

export async function describeCrawled(outDir: string, facts: RawFacts, client: DescribeClient): Promise<L3Result> {
  const absOut = path.resolve(outDir);
  const cacheDir = path.join(absOut, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const descriptions: L3Result["descriptions"] = new Map();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const page of facts.pages) {
    const hash = hashCrawledPage(page.route, page.renderedText ?? "", page.elements);
    const cachePath = path.join(cacheDir, `${hash}.json`);

    if (fs.existsSync(cachePath)) {
      descriptions.set(page.route, JSON.parse(fs.readFileSync(cachePath, "utf8")));
      cacheHits += 1;
      continue;
    }

    const description = await client.describePage({
      route: page.route,
      file: page.file, // a URL in crawl mode, not a filesystem path
      source: page.renderedText ?? "",
      elements: page.elements.map(toDescribeElementInput),
    });

    fs.writeFileSync(cachePath, JSON.stringify(description, null, 2));
    descriptions.set(page.route, description);
    cacheMisses += 1;
  }

  // Crawl mode has no static concept of "present on every page" (that's a
  // component-import fact l1-scan.ts derives from source) — nav bars etc.
  // just show up as regular elements on every crawled page that renders
  // them, described individually per page like anything else.
  return { descriptions, globalElements: [], cacheHits, cacheMisses };
}

function toDescribeElementInput(el: RawElement) {
  return {
    id: el.id,
    tag: el.tag,
    text: el.text,
    dataAi: el.dataAi,
    ariaLabel: el.ariaLabel,
    handlerCall: el.handlerCall,
  };
}

function hashCrawledPage(route: string, renderedText: string, elements: RawElement[]): string {
  const hash = createHash("sha256");
  hash.update(route);
  hash.update(renderedText);
  hash.update(JSON.stringify(elements));
  return hash.digest("hex");
}

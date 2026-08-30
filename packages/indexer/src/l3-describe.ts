// L3 — the only phase that talks to an LLM. Content-hash cached so a
// warm build with no relevant source changes never calls the model again.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RawFacts, RawPage } from "./types";
import type { DescribeClient, PageDescription } from "./llm";

const CACHE_DIR = ".cairn-cache";

export interface L3Result {
  descriptions: Map<string, PageDescription>; // keyed by page.route
  cacheHits: number;
  cacheMisses: number;
}

export async function describeAll(rootDir: string, facts: RawFacts, client: DescribeClient): Promise<L3Result> {
  const absRoot = path.resolve(rootDir);
  const cacheDir = path.join(absRoot, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const descriptions = new Map<string, PageDescription>();
  let cacheHits = 0;
  let cacheMisses = 0;

  for (const page of facts.pages) {
    const hash = hashPage(absRoot, page);
    const cachePath = path.join(cacheDir, `${hash}.json`);

    if (fs.existsSync(cachePath)) {
      descriptions.set(page.route, JSON.parse(fs.readFileSync(cachePath, "utf8")));
      cacheHits += 1;
      continue;
    }

    const source = fs.readFileSync(path.join(absRoot, page.file), "utf8");
    const description = await client.describePage({
      route: page.route,
      file: page.file,
      source,
      elements: page.elements.map((el) => ({
        id: el.id,
        tag: el.tag,
        text: el.text,
        dataAi: el.dataAi,
        ariaLabel: el.ariaLabel,
        handlerCall: el.handlerCall,
      })),
    });

    fs.writeFileSync(cachePath, JSON.stringify(description, null, 2));
    descriptions.set(page.route, description);
    cacheMisses += 1;
  }

  return { descriptions, cacheHits, cacheMisses };
}

/**
 * Hash the page file plus every file reachable from it, so any change
 * anywhere in the page's component subtree invalidates the cache — but an
 * unrelated page elsewhere in the app never does (that's what makes warm
 * builds fast).
 */
function hashPage(absRoot: string, page: RawPage): string {
  const hash = createHash("sha256");
  hash.update(page.route);
  hash.update(JSON.stringify(page.elements));
  for (const file of page.reachableFiles) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(absRoot, file), "utf8"));
  }
  return hash.digest("hex");
}

// L3 — the only phase that talks to an LLM. Content-hash cached so a
// warm build with no relevant source changes never calls the model again.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RawElement, RawFacts, RawPage } from "./types";
import type { DescribeClient, ElementDescription, PageDescription } from "./llm";

const CACHE_DIR = ".cairn-cache";
const GLOBAL_ROUTE_LABEL = "(present on every page — layout/framework elements)";

export interface L3Result {
  descriptions: Map<string, PageDescription>; // keyed by page.route
  /** Descriptions for frameworkElements (nav bars etc.) — present on every page, so kept out of `descriptions`. */
  globalElements: ElementDescription[];
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
      elements: page.elements.map(toDescribeElementInput),
    });

    fs.writeFileSync(cachePath, JSON.stringify(description, null, 2));
    descriptions.set(page.route, description);
    cacheMisses += 1;
  }

  let globalElements: ElementDescription[] = [];
  if (facts.frameworkElements.length > 0) {
    const hash = hashFrameworkElements(absRoot, facts.frameworkElements);
    const cachePath = path.join(cacheDir, `${hash}.json`);

    if (fs.existsSync(cachePath)) {
      globalElements = JSON.parse(fs.readFileSync(cachePath, "utf8"));
      cacheHits += 1;
    } else {
      const files = uniqueSortedFiles(facts.frameworkElements);
      const source = files.map((f) => fs.readFileSync(path.join(absRoot, f), "utf8")).join("\n\n");
      const description = await client.describePage({
        route: GLOBAL_ROUTE_LABEL,
        file: files.join(", "),
        source,
        elements: facts.frameworkElements.map(toDescribeElementInput),
      });
      globalElements = description.elements;
      fs.writeFileSync(cachePath, JSON.stringify(globalElements, null, 2));
      cacheMisses += 1;
    }
  }

  return { descriptions, globalElements, cacheHits, cacheMisses };
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

function uniqueSortedFiles(elements: RawElement[]): string[] {
  return Array.from(new Set(elements.map((e) => e.file))).sort();
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

function hashFrameworkElements(absRoot: string, elements: RawElement[]): string {
  const hash = createHash("sha256");
  hash.update("global");
  hash.update(JSON.stringify(elements));
  for (const file of uniqueSortedFiles(elements)) {
    hash.update(file);
    hash.update(fs.readFileSync(path.join(absRoot, file), "utf8"));
  }
  return hash.digest("hex");
}

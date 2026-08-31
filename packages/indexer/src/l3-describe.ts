// L3 — the only phase that talks to an LLM. Content-hash cached so a
// warm build with no relevant source changes never calls the model again.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { RawElement, RawFacts, RawPage } from "./types";
import type { DescribeClient, ElementDescription, PageDescription } from "./llm";
import { mapWithConcurrency, withRetry } from "./concurrency";

const CACHE_DIR = ".cairn-cache";
const GLOBAL_ROUTE_LABEL = "(present on every page — layout/framework elements)";
// GroqDescribeClient's KeyRotator round-robins multiple keys specifically
// for this kind of throughput — a large app's cold build (hundreds of
// pages) sequentially would take minutes even at ~1-2s/call. Kept modest
// rather than maximal: still bounded by whatever the provider's real rate
// limit is, this just stops leaving 3 of 4 rotated keys idle.
const DEFAULT_DESCRIBE_CONCURRENCY = 6;

export interface L3Result {
  descriptions: Map<string, PageDescription>; // keyed by page.route
  /** Descriptions for frameworkElements (nav bars etc.) — present on every page, so kept out of `descriptions`. */
  globalElements: ElementDescription[];
  cacheHits: number;
  cacheMisses: number;
}

export async function describeAll(
  rootDir: string,
  facts: RawFacts,
  client: DescribeClient,
  concurrency = DEFAULT_DESCRIBE_CONCURRENCY,
): Promise<L3Result> {
  const absRoot = path.resolve(rootDir);
  const cacheDir = path.join(absRoot, CACHE_DIR);
  fs.mkdirSync(cacheDir, { recursive: true });

  const descriptions = new Map<string, PageDescription>();
  let cacheHits = 0;
  let cacheMisses = 0;

  // Cache lookups are synchronous local disk reads — cheap, done up front,
  // sequentially, in original page order (so descriptions.set() below still
  // reflects a deterministic pass even though the actual LLM calls run out
  // of order). Only genuine cache misses need the network and benefit from
  // the concurrency pool.
  const toDescribe: { page: RawPage; cachePath: string }[] = [];
  for (const page of facts.pages) {
    const hash = hashPage(absRoot, page);
    const cachePath = path.join(cacheDir, `${hash}.json`);

    if (fs.existsSync(cachePath)) {
      descriptions.set(page.route, JSON.parse(fs.readFileSync(cachePath, "utf8")));
      cacheHits += 1;
      continue;
    }
    toDescribe.push({ page, cachePath });
  }

  await mapWithConcurrency(toDescribe, concurrency, async ({ page, cachePath }) => {
    const source = fs.readFileSync(path.join(absRoot, page.file), "utf8");
    let description: PageDescription;
    try {
      description = await withRetry(() =>
        client.describePage({
          route: page.route,
          file: page.file,
          source,
          elements: page.elements.map(toDescribeElementInput),
        }),
      );
    } catch (err) {
      // One page permanently failing (retries exhausted, or a
      // non-retryable error) must never abort the whole build — every
      // other page's already-completed work would be discarded too, on a
      // large app that's minutes of real API spend thrown away over one
      // bad page. Degrade that page only, log it loudly, keep going.
      console.error(`[cairn] describing ${page.route} failed after retries — degrading this page only:`, err);
      description = degradedDescription(page.elements);
    }

    fs.writeFileSync(cachePath, JSON.stringify(description, null, 2));
    descriptions.set(page.route, description);
    cacheMisses += 1;
  });

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
      let description: PageDescription;
      try {
        description = await withRetry(() =>
          client.describePage({
            route: GLOBAL_ROUTE_LABEL,
            file: files.join(", "),
            source,
            elements: facts.frameworkElements.map(toDescribeElementInput),
          }),
        );
      } catch (err) {
        console.error(`[cairn] describing framework elements failed after retries — degrading:`, err);
        description = degradedDescription(facts.frameworkElements);
      }
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

/** Honest zero-confidence stand-in for a page/framework-element group whose
 * description call failed even after retries — never blocks the rest of
 * the build, and confidence: 0 makes it visibly distinct from a real
 * (if uncertain) LLM answer, not silently indistinguishable from one. */
function degradedDescription(elements: RawElement[]): PageDescription {
  return {
    title: "(description unavailable)",
    purpose: "Could not be described — the description service failed after retries.",
    whenToUse: "Unknown.",
    confidence: 0,
    elements: elements.map((el) => ({ id: el.id, does: "Unknown — description generation failed.", confidence: 0 })),
  };
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

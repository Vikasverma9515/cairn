// Framework-agnostic analyzer: instead of parsing a framework's *source
// code* (l1-scan.ts, Next.js-only), this crawls the *rendered* app with a
// headless browser and reads the live DOM — by the time a page reaches the
// browser, Vue/Angular/Svelte/Next.js output is just DOM, so this one
// crawler works on any of them without a framework-specific parser.
//
// Trade-off, stated plainly (see ROADMAP.md Phase 2): needs a running
// server to crawl, and can't see handler/API-call evidence the way reading
// real source can — an element's "does" description is inferred from its
// visible text and page context alone. Output is the exact same RawFacts
// shape l1-scan.ts produces, so everything downstream (computeL2,
// describeAll's DescribeClient, assembleManifest) needs zero changes.

import { chromium, type Browser, type Page } from "playwright";
import type { InteractiveTag, RawElement, RawFacts, RawPage } from "./types";
import { mapWithConcurrency } from "./concurrency";

export interface CrawlOptions {
  startUrl: string;
  /** Stop after this many pages. Keeps a large or looping site from crawling forever. */
  maxPages?: number;
  /** How many link-hops from startUrl to follow. */
  maxDepth?: number;
  /** Max seconds to wait for each page to settle before extracting it. */
  pageTimeoutMs?: number;
  /** How many pages to visit at once. A handful, not maximal — a small dev server shouldn't get hammered. */
  concurrency?: number;
}

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
const DEFAULT_CRAWL_CONCURRENCY = 4;

interface ExtractedPageData {
  elements: RawElement[];
  links: string[];
  bodyText: string;
}

/**
 * Visits every page reachable within maxDepth hops of startUrl, one BFS
 * "level" at a time — same-depth pages are visited concurrently (bounded
 * pool, real parallel tabs in the same browser context), then their
 * discovered links become the next level. Processing depth-by-depth rather
 * than a single shared work queue sidesteps the coordination problem of
 * "is a concurrent worker really done, or about to discover more work" —
 * simpler to reason about correctly, at the minor cost of a slightly
 * bursty (not perfectly smoothed) request pattern.
 */
export async function crawlSite(opts: CrawlOptions): Promise<RawFacts> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const pageTimeoutMs = opts.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;
  const concurrency = opts.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;

  const startUrl = new URL(opts.startUrl);
  const origin = startUrl.origin;

  const browser: Browser = await chromium.launch();
  const pages: RawPage[] = [];
  const visited = new Set<string>([normalizeForDedup(startUrl.toString())]);

  try {
    const context = await browser.newContext();
    let currentLevel: string[] = [startUrl.toString()];
    let depth = 0;

    while (currentLevel.length > 0 && depth <= maxDepth && pages.length < maxPages) {
      const budget = Math.max(0, maxPages - pages.length);
      const levelUrls = currentLevel.slice(0, budget);

      const linkBatches = await mapWithConcurrency(levelUrls, concurrency, async (url) => {
        const page = await context.newPage();
        try {
          const response = await page.goto(url, { waitUntil: "networkidle", timeout: pageTimeoutMs });
          if (!response || !response.ok()) {
            console.error(`[cairn crawl] skipping ${url} — HTTP ${response?.status() ?? "no response"}`);
            return [] as string[];
          }
          const finalUrl = page.url();
          const extracted = await extractPageData(page);
          const route = new URL(finalUrl).pathname || "/";
          pages.push({
            route,
            file: finalUrl,
            reachableFiles: [],
            elements: extracted.elements,
            renderedText: extracted.bodyText,
          });

          if (depth >= maxDepth) return [] as string[];
          const nextLinks: string[] = [];
          for (const href of extracted.links) {
            let abs: URL;
            try {
              abs = new URL(href, finalUrl);
            } catch {
              continue;
            }
            if (abs.origin !== origin) continue;
            nextLinks.push(abs.toString());
          }
          return nextLinks;
        } catch (err) {
          console.error(`[cairn crawl] skipping ${url} — ${err instanceof Error ? err.message : String(err)}`);
          return [] as string[];
        } finally {
          await page.close();
        }
      });

      const nextLevel: string[] = [];
      for (const links of linkBatches) {
        for (const url of links) {
          const key = normalizeForDedup(url);
          if (visited.has(key)) continue;
          visited.add(key);
          nextLevel.push(url);
        }
      }

      currentLevel = nextLevel;
      depth += 1;
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return {
    version: "1",
    pages,
    allScannedFiles: [],
    frameworkReachableFiles: [],
    frameworkElements: [],
  };
}

function normalizeForDedup(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname; // query/hash don't distinguish routes for crawl purposes
}

/**
 * Runs inside the page (page.evaluate — this function is serialized and
 * executed in the browser's context, not Node's), so it can only use
 * plain DOM APIs, nothing from the surrounding module.
 */
async function extractPageData(page: Page): Promise<ExtractedPageData> {
  return page.evaluate(() => {
    function normalizeText(t: string | null): string {
      return (t ?? "").trim().replace(/\s+/g, " ");
    }

    const seen = new Set<string>();
    const elements: {
      id: string;
      tag: string;
      dataAi: string | null;
      ariaLabel: string | null;
      text: string | null;
      handlerCall: null;
      file: string;
      line: number;
    }[] = [];

    const candidates = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, a, [role='button'], input[type='submit'], input[type='button'], [data-ai]",
      ),
    );

    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not actually visible

      const dataAi = el.getAttribute("data-ai");
      const ariaLabel = el.getAttribute("aria-label");
      const text = normalizeText(el.textContent);

      // Id is the raw (not slugified) data-ai/aria-label/text value, on
      // purpose — the runtime widget's findElement() ladder matches
      // aria-label and text *exactly as they appear on the element*, so a
      // slugified id (e.g. "new-invoice") would never actually be found at
      // runtime for an element with no data-ai. Nothing to identify or
      // meaningfully describe an element by (no data-ai, no aria-label, no
      // text) means it's skipped, not guessed at.
      const id = dataAi || ariaLabel || text;
      if (!id) continue;
      if (seen.has(id)) continue; // first occurrence of a repeated element (e.g. every row's "Archive") stands in for all of them
      seen.add(id);

      const tagName = el.tagName.toLowerCase();
      const tag = tagName === "a" ? "a" : tagName === "input" ? "input" : tagName === "form" ? "form" : "button";

      elements.push({
        id,
        tag,
        dataAi: dataAi || null,
        ariaLabel: ariaLabel || null,
        text: text || null,
        handlerCall: null,
        file: location.href,
        line: 0,
      });
    }

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((a) => a.getAttribute("href"))
      .filter((h): h is string => !!h && !/^(mailto:|tel:|javascript:|#)/.test(h));

    const bodyText = document.body.innerText.trim().replace(/\n{3,}/g, "\n\n").slice(0, 12_000);

    return { elements, links, bodyText };
  }) as unknown as Promise<ExtractedPageData>;
}

export type { InteractiveTag };

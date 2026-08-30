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

export interface CrawlOptions {
  startUrl: string;
  /** Stop after this many pages. Keeps a large or looping site from crawling forever. */
  maxPages?: number;
  /** How many link-hops from startUrl to follow. */
  maxDepth?: number;
  /** Max seconds to wait for each page to settle before extracting it. */
  pageTimeoutMs?: number;
}

const DEFAULT_MAX_PAGES = 30;
const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_PAGE_TIMEOUT_MS = 15_000;

interface ExtractedPageData {
  elements: RawElement[];
  links: string[];
  bodyText: string;
}

export async function crawlSite(opts: CrawlOptions): Promise<RawFacts> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const pageTimeoutMs = opts.pageTimeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS;

  const startUrl = new URL(opts.startUrl);
  const origin = startUrl.origin;

  const browser: Browser = await chromium.launch();
  const pages: RawPage[] = [];

  try {
    const context = await browser.newContext();
    const visited = new Set<string>();
    const queue: { url: string; depth: number }[] = [{ url: startUrl.toString(), depth: 0 }];

    while (queue.length > 0 && pages.length < maxPages) {
      const next = queue.shift()!;
      const key = normalizeForDedup(next.url);
      if (visited.has(key)) continue;
      visited.add(key);

      const page = await context.newPage();
      let extracted: ExtractedPageData | null = null;
      let finalUrl = next.url;
      try {
        const response = await page.goto(next.url, { waitUntil: "networkidle", timeout: pageTimeoutMs });
        if (!response || !response.ok()) {
          console.error(`[cairn crawl] skipping ${next.url} — HTTP ${response?.status() ?? "no response"}`);
          continue;
        }
        finalUrl = page.url();
        extracted = await extractPageData(page);
      } catch (err) {
        console.error(`[cairn crawl] skipping ${next.url} — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      } finally {
        await page.close();
      }

      const route = new URL(finalUrl).pathname || "/";
      pages.push({
        route,
        file: finalUrl,
        reachableFiles: [],
        elements: extracted.elements,
        renderedText: extracted.bodyText,
      });

      if (next.depth < maxDepth) {
        for (const href of extracted.links) {
          let abs: URL;
          try {
            abs = new URL(href, finalUrl);
          } catch {
            continue;
          }
          if (abs.origin !== origin) continue;
          const linkKey = normalizeForDedup(abs.toString());
          if (!visited.has(linkKey)) queue.push({ url: abs.toString(), depth: next.depth + 1 });
        }
      }
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

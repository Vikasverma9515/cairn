// Unlike l1-scan.test.ts's fixture-directory approach, crawl mode has no
// source to point at — it needs a running server. Spins up a tiny local
// HTTP server (Node's own http module, no extra dependency) serving a
// couple of plain HTML pages, and a real headless Chromium (via
// crawlSite() itself) to crawl them. This is the automated-test coverage
// ROADMAP.md flagged as missing — the live 2-page-static-site run this
// session proved the mechanism works; this is what makes that repeatable
// in CI instead of only ever having been a manual live check.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crawlSite } from "./crawl";

describe("crawlSite", () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/" || req.url === "/index.html") {
        res.end(`<!doctype html><html><body>
          <h1>Home</h1>
          <a href="/about.html">About</a>
          <button data-ai="start-order">Start an Order</button>
          <button aria-label="Contact support">Contact Support</button>
          <a href="https://external.example.com/">External link</a>
        </body></html>`);
      } else if (req.url === "/about.html") {
        res.end(`<!doctype html><html><body>
          <h1>About</h1>
          <a href="/index.html">Back home</a>
          <button aria-label="Subscribe to newsletter">Subscribe</button>
        </body></html>`);
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it(
    "crawls reachable same-origin pages and extracts interactive elements with raw (non-slugified) ids",
    async () => {
      const facts = await crawlSite({ startUrl: `${baseUrl}/index.html`, maxPages: 10, maxDepth: 2 });

      const routes = facts.pages.map((p) => p.route).sort();
      expect(routes).toEqual(["/about.html", "/index.html"]);

      const home = facts.pages.find((p) => p.route === "/index.html")!;
      const homeIds = home.elements.map((e) => e.id).sort();
      // "About" (raw link text, not "about") and "start-order" (the real
      // data-ai value) — never a slugified form like "start-an-order". The
      // external link is extracted as an element too (a user could
      // legitimately ask about it) even though it's never *followed* for
      // further crawling — see the separate same-origin test below.
      expect(homeIds).toEqual(["About", "Contact support", "External link", "start-order"]);

      const startOrder = home.elements.find((e) => e.id === "start-order")!;
      expect(startOrder.dataAi).toBe("start-order");
      expect(startOrder.tag).toBe("button");

      const contactSupport = home.elements.find((e) => e.id === "Contact support")!;
      expect(contactSupport.ariaLabel).toBe("Contact support");
      expect(contactSupport.dataAi).toBeNull();

      const about = facts.pages.find((p) => p.route === "/about.html")!;
      const aboutIds = about.elements.map((e) => e.id).sort();
      expect(aboutIds).toEqual(["Back home", "Subscribe to newsletter"]);
    },
    30_000, // real browser launch + two real page navigations
  );

  it(
    "never follows a link to a different origin",
    async () => {
      const facts = await crawlSite({ startUrl: `${baseUrl}/index.html`, maxPages: 10, maxDepth: 3 });
      const routes = facts.pages.map((p) => p.route);
      expect(routes.every((r) => r === "/index.html" || r === "/about.html")).toBe(true);
    },
    30_000,
  );

  it(
    "respects maxPages even when more pages are reachable",
    async () => {
      const facts = await crawlSite({ startUrl: `${baseUrl}/index.html`, maxPages: 1, maxDepth: 2 });
      expect(facts.pages.length).toBe(1);
      expect(facts.pages[0].route).toBe("/index.html");
    },
    30_000,
  );

  it(
    "respects maxDepth — depth 0 crawls only the start page, no links followed",
    async () => {
      const facts = await crawlSite({ startUrl: `${baseUrl}/index.html`, maxPages: 10, maxDepth: 0 });
      expect(facts.pages.map((p) => p.route)).toEqual(["/index.html"]);
    },
    30_000,
  );

  it(
    "captures the page's rendered text for the LLM describe step",
    async () => {
      const facts = await crawlSite({ startUrl: `${baseUrl}/index.html`, maxPages: 1, maxDepth: 0 });
      expect(facts.pages[0].renderedText).toContain("Home");
    },
    30_000,
  );

  it(
    "skips an unreachable/erroring URL instead of crashing the whole crawl",
    async () => {
      // A start URL that 404s should just produce zero pages, not throw.
      await expect(crawlSite({ startUrl: `${baseUrl}/does-not-exist.html`, maxPages: 5 })).resolves.toEqual(
        expect.objectContaining({ pages: [] }),
      );
    },
    30_000,
  );
});

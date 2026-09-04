import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanL1 } from "./l1-scan";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../fixtures/simple-app");

describe("scanL1", () => {
  it("finds App Router and Pages Router routes side by side", () => {
    const facts = scanL1(FIXTURE);
    const routes = facts.pages.map((p) => p.route).sort();
    expect(routes).toEqual(["/", "/about", "/contact"]);
  });

  it("derives the Pages Router route from its file, not app/", () => {
    const facts = scanL1(FIXTURE);
    const contact = facts.pages.find((p) => p.route === "/contact")!;
    expect(contact.file).toBe("pages/contact.tsx");
  });

  it("never treats pages/_app.tsx or pages/api/** as a page", () => {
    const facts = scanL1(FIXTURE);
    const routes = facts.pages.map((p) => p.file);
    expect(routes).not.toContain("pages/_app.tsx");
    expect(routes).not.toContain("pages/api/ping.ts");
  });

  it("still scans _app.tsx and api routes for reachability (framework-invoked, not dead)", () => {
    const facts = scanL1(FIXTURE);
    expect(facts.allScannedFiles).toContain("pages/_app.tsx");
    expect(facts.allScannedFiles).toContain("pages/api/ping.ts");
    expect(facts.frameworkReachableFiles).toContain("pages/_app.tsx");
    expect(facts.frameworkReachableFiles).toContain("pages/api/ping.ts");
  });

  it("traces a next/link Link by its href when it has no data-ai or onClick", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    const link = home.elements.find((e) => e.text === "Contact us");
    expect(link).toBeDefined();
    expect(link?.tag).toBe("a");
    expect(link?.handlerCall).toBe("navigate /contact");
    // Raw text, not slugified ("contact-us") — the runtime widget's
    // findElement() ladder matches an element's actual (normalized) text
    // content, never a hyphenated slug, so the manifest id has to be the
    // real value or a highlight/click on this element would never resolve.
    expect(link?.id).toBe("Contact us");
  });

  it("treats a *Button-named component with an onClick as a button (heuristic)", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    const archiveButton = home.elements.find((e) => e.file === "app/page.tsx" && e.text === "Archive");
    expect(archiveButton).toBeDefined();
    expect(archiveButton?.tag).toBe("button");
    expect(archiveButton?.handlerCall).toBe("POST /api/items/archive");
    expect(archiveButton?.id).toBe("Archive"); // same reasoning — raw text, not slugified
  });

  it("finds the create-item button with its data-ai id and traced API call", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    const button = home.elements.find((e) => e.id === "create-item");
    expect(button).toBeDefined();
    expect(button?.tag).toBe("button");
    expect(button?.dataAi).toBe("create-item");
    expect(button?.text).toBe("Create Item");
    expect(button?.handlerCall).toBe("POST /api/items");
  });

  it("finds the about link via data-ai, with no handler", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    const link = home.elements.find((e) => e.id === "about-link");
    expect(link?.tag).toBe("a");
    expect(link?.handlerCall).toBeNull();
  });

  it("lists CreateButton.tsx as reachable from the home route", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    expect(home.reachableFiles).toContain("components/CreateButton.tsx");
  });

  it("includes DeadWidget.tsx in allScannedFiles but in no page's reachable set", () => {
    const facts = scanL1(FIXTURE);
    expect(facts.allScannedFiles).toContain("components/DeadWidget.tsx");
    const reachableAnywhere = new Set(facts.pages.flatMap((p) => p.reachableFiles));
    expect(reachableAnywhere.has("components/DeadWidget.tsx")).toBe(false);
  });

  it("is deterministic across repeated runs", () => {
    const a = scanL1(FIXTURE);
    const b = scanL1(FIXTURE);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("wires a dataShapes array (possibly empty) onto every page — the extraction logic itself is covered by l1-data-shapes.test.ts", () => {
    const facts = scanL1(FIXTURE);
    for (const page of facts.pages) {
      expect(Array.isArray(page.dataShapes)).toBe(true);
    }
    // This fixture's pages don't call any function with an explicit,
    // interface/type-alias-shaped return annotation — a real, deliberate
    // "no shape found" case (l1-data-shapes.test.ts's own "skips a function
    // with no explicit return-type annotation" case is the same scenario in
    // isolation), not a bug.
    const home = facts.pages.find((p) => p.route === "/")!;
    expect(home.dataShapes).toEqual([]);
  });

  it("wires apiRouteHandlers onto RawFacts — this fixture's only API route is Pages Router (pages/api/ping.ts), correctly out of scope for v1's App-Router-only extraction", () => {
    const facts = scanL1(FIXTURE);
    expect(Array.isArray(facts.apiRouteHandlers)).toBe(true);
    expect(facts.apiRouteHandlers).toEqual([]);
  });

  it("wires real in-app copy onto every page — the fixture's own real <h1>/<p> content, not invented for this test", () => {
    const facts = scanL1(FIXTURE);
    const about = facts.pages.find((p) => p.route === "/about")!;
    expect(about.inAppCopy).toEqual([
      { tag: "h1", text: "About", file: "app/about/page.tsx", line: expect.any(Number) },
      { tag: "p", text: "This is the about page.", file: "app/about/page.tsx", line: expect.any(Number) },
    ]);

    const home = facts.pages.find((p) => p.route === "/")!;
    expect(home.inAppCopy).toEqual([{ tag: "h1", text: "Welcome", file: "app/page.tsx", line: expect.any(Number) }]);
  });
});

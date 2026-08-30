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
  });

  it("treats a *Button-named component with an onClick as a button (heuristic)", () => {
    const facts = scanL1(FIXTURE);
    const home = facts.pages.find((p) => p.route === "/")!;
    const archiveButton = home.elements.find((e) => e.file === "app/page.tsx" && e.text === "Archive");
    expect(archiveButton).toBeDefined();
    expect(archiveButton?.tag).toBe("button");
    expect(archiveButton?.handlerCall).toBe("POST /api/items/archive");
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
});

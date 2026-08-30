import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanL1 } from "./l1-scan";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../fixtures/simple-app");

describe("scanL1", () => {
  it("finds both routes", () => {
    const facts = scanL1(FIXTURE);
    const routes = facts.pages.map((p) => p.route).sort();
    expect(routes).toEqual(["/", "/about"]);
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

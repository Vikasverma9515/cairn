import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanL1 } from "./l1-scan";
import { computeL2 } from "./l2-reachability";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../fixtures/simple-app");

describe("computeL2", () => {
  it("flags DeadWidget.tsx as dead code", () => {
    const facts = scanL1(FIXTURE);
    const l2 = computeL2(FIXTURE, facts);
    expect(l2.dead).toContain("components/DeadWidget.tsx");
  });

  it("does not flag reachable files as dead", () => {
    const facts = scanL1(FIXTURE);
    const l2 = computeL2(FIXTURE, facts);
    expect(l2.dead).not.toContain("components/CreateButton.tsx");
    expect(l2.dead).not.toContain("app/page.tsx");
  });

  it("does not flag Pages Router framework files (_app, api routes) as dead", () => {
    const facts = scanL1(FIXTURE);
    const l2 = computeL2(FIXTURE, facts);
    expect(l2.dead).not.toContain("pages/_app.tsx");
    expect(l2.dead).not.toContain("pages/api/ping.ts");
  });

  it("finds no naming conflicts in the fixture (nothing to disambiguate)", () => {
    const facts = scanL1(FIXTURE);
    const l2 = computeL2(FIXTURE, facts);
    expect(l2.conflicts).toEqual([]);
  });
});

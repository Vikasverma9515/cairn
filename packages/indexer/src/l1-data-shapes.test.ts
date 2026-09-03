import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { extractDataShapes } from "./l1-data-shapes";

const ABS_ROOT = "/repo";

function makeProject(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [rel, content] of Object.entries(files)) {
    project.createSourceFile(`${ABS_ROOT}/${rel}`, content);
  }
  return project;
}

function abs(...rel: string[]): string[] {
  return rel.map((r) => `${ABS_ROOT}/${r}`);
}

describe("extractDataShapes", () => {
  it("traces a real interface from an explicit array return type, same file", () => {
    const project = makeProject({
      "lib/invoices.ts": `
        export interface Invoice { id: string; amount: string; status: "Paid" | "Overdue" | "Archived"; }
        export function listInvoices(): Invoice[] { return []; }
      `,
      "app/page.tsx": `
        import { listInvoices } from "../lib/invoices";
        export default function Page() { const invoices = listInvoices(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/invoices.ts"));

    expect(shapes).toEqual([
      {
        name: "Invoice",
        source: "lib/invoices.ts",
        fields: [
          { name: "amount", type: "string", optional: false },
          { name: "id", type: "string", optional: false },
          { name: "status", type: '"Paid" | "Overdue" | "Archived"', optional: false },
        ],
      },
    ]);
  });

  it("chases an import when the return type names a type only imported into the calling file (the board.ts/board-types.ts split-file convention)", () => {
    const project = makeProject({
      "lib/board-types.ts": `
        export interface BoardCard { id: string; title: string; }
        export interface BoardColumn { id: string; cards: BoardCard[]; }
      `,
      "lib/board.ts": `
        import type { BoardColumn } from "./board-types";
        export function listBoard(): BoardColumn[] { return []; }
      `,
      "app/board/page.tsx": `
        import { listBoard } from "../../lib/board";
        export default function Page() { const columns = listBoard(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/board/page.tsx", "lib/board.ts", "lib/board-types.ts"));

    expect(shapes).toEqual([
      {
        name: "BoardColumn",
        source: "lib/board-types.ts",
        fields: [
          { name: "cards", type: "BoardCard[]", optional: false },
          { name: "id", type: "string", optional: false },
        ],
      },
    ]);
  });

  it("unwraps a nullable return type (Foo | null) to the same shape", () => {
    const project = makeProject({
      "lib/invoices.ts": `
        export interface Invoice { id: string; }
        export function archiveInvoice(id: string): Invoice | null { return null; }
      `,
      "app/page.tsx": `
        import { archiveInvoice } from "../lib/invoices";
        export default function Page() { archiveInvoice("1"); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/invoices.ts"));
    expect(shapes.map((s) => s.name)).toEqual(["Invoice"]);
  });

  it("reads an object-shaped type alias the same way as an interface", () => {
    const project = makeProject({
      "lib/cart.ts": `
        export type CartLine = { productId: string; quantity: number };
        export function listCart(): CartLine[] { return []; }
      `,
      "app/page.tsx": `
        import { listCart } from "../lib/cart";
        export default function Page() { const cart = listCart(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/cart.ts"));
    expect(shapes).toEqual([
      {
        name: "CartLine",
        source: "lib/cart.ts",
        fields: [
          { name: "productId", type: "string", optional: false },
          { name: "quantity", type: "number", optional: false },
        ],
      },
    ]);
  });

  it("reports optional fields", () => {
    const project = makeProject({
      "lib/items.ts": `
        export interface Item { id: string; note?: string; }
        export function listItems(): Item[] { return []; }
      `,
      "app/page.tsx": `
        import { listItems } from "../lib/items";
        export default function Page() { listItems(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/items.ts"));
    expect(shapes[0].fields).toContainEqual({ name: "note", type: "string", optional: true });
  });

  it("skips a function with no explicit return-type annotation — no full type-checker inference", () => {
    const project = makeProject({
      "lib/items.ts": `
        export interface Item { id: string; }
        export function listItems() { return [{ id: "1" }] as Item[]; }
      `,
      "app/page.tsx": `
        import { listItems } from "../lib/items";
        export default function Page() { listItems(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/items.ts"));
    expect(shapes).toEqual([]);
  });

  it("skips a union type alias — not an object shape, no fields to report", () => {
    const project = makeProject({
      "lib/status.ts": `
        export type Status = "draft" | "sent" | "paid";
        export function getStatus(): Status { return "draft"; }
      `,
      "app/page.tsx": `
        import { getStatus } from "../lib/status";
        export default function Page() { getStatus(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/status.ts"));
    expect(shapes).toEqual([]);
  });

  it("dedupes a shape referenced by multiple calls, and sorts the result by name", () => {
    const project = makeProject({
      "lib/data.ts": `
        export interface Zebra { id: string; }
        export interface Apple { id: string; }
        export function listZebras(): Zebra[] { return []; }
        export function getZebra(): Zebra | null { return null; }
        export function listApples(): Apple[] { return []; }
      `,
      "app/page.tsx": `
        import { listZebras, getZebra, listApples } from "../lib/data";
        export default function Page() { listZebras(); getZebra(); listApples(); return null; }
      `,
    });

    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "lib/data.ts"));
    expect(shapes.map((s) => s.name)).toEqual(["Apple", "Zebra"]);
  });

  it("returns an empty array when no reachable file resolves in the project", () => {
    const project = makeProject({ "app/page.tsx": `export default function Page() { return null; }` });
    const shapes = extractDataShapes(project, ABS_ROOT, abs("app/page.tsx", "does/not/exist.ts"));
    expect(shapes).toEqual([]);
  });
});

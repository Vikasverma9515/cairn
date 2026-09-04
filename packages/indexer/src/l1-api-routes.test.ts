import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { mapApiRouteHandlers } from "./l1-api-routes";

const ABS_ROOT = "/repo";

function makeProject(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [rel, content] of Object.entries(files)) {
    project.createSourceFile(`${ABS_ROOT}/${rel}`, content);
  }
  return project;
}

describe("mapApiRouteHandlers", () => {
  it("traces a real POST handler back to the real, imported, project-local function it calls", () => {
    const project = makeProject({
      "lib/invoices.ts": `
        export function createInvoice() { return { id: "1" }; }
        export function listInvoices() { return []; }
      `,
      "app/api/invoices/route.ts": `
        import { NextResponse } from "next/server";
        import { createInvoice, listInvoices } from "../../../lib/invoices";
        export async function GET() { return NextResponse.json(listInvoices()); }
        export async function POST() { const invoice = createInvoice(); return NextResponse.json(invoice, { status: 201 }); }
      `,
    });

    const handlers = mapApiRouteHandlers(project, ABS_ROOT);

    expect(handlers).toEqual([
      { method: "GET", url: "/api/invoices", file: "app/api/invoices/route.ts", calls: ["listInvoices"] },
      { method: "POST", url: "/api/invoices", file: "app/api/invoices/route.ts", calls: ["createInvoice"] },
    ]);
  });

  it("resolves an arrow-function handler (export const POST = async () => {...}) the same way", () => {
    const project = makeProject({
      "lib/cards.ts": `export function createCard() { return { id: "1" }; }`,
      "app/api/board/cards/route.ts": `
        import { NextResponse } from "next/server";
        import { createCard } from "../../../../lib/cards";
        export const POST = async () => {
          const card = createCard();
          return NextResponse.json(card);
        };
      `,
    });

    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(handlers).toEqual([{ method: "POST", url: "/api/board/cards", file: "app/api/board/cards/route.ts", calls: ["createCard"] }]);
  });

  it("never mistakes a library/global call (NextResponse.json, db.prepare) for a real project function", () => {
    const project = makeProject({
      "app/api/ping/route.ts": `
        import { NextResponse } from "next/server";
        export async function GET() { return NextResponse.json({ ok: true }); }
      `,
    });

    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(handlers).toEqual([{ method: "GET", url: "/api/ping", file: "app/api/ping/route.ts", calls: [] }]);
  });

  it("dedupes and sorts multiple calls to the same or different real functions", () => {
    const project = makeProject({
      "lib/x.ts": `export function zebra() {} export function apple() {}`,
      "app/api/things/route.ts": `
        import { zebra, apple } from "../../../lib/x";
        export async function POST() { zebra(); apple(); zebra(); return null; }
      `,
    });

    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(handlers[0].calls).toEqual(["apple", "zebra"]);
  });

  it("skips a route.ts outside app/api/ — a non-API route handler isn't in scope for v1", () => {
    const project = makeProject({
      "app/sitemap.xml/route.ts": `export async function GET() { return null; }`,
    });
    expect(mapApiRouteHandlers(project, ABS_ROOT)).toEqual([]);
  });

  it("skips Pages Router API routes (pages/api/*.ts) — a materially different, single-default-export shape, not attempted", () => {
    const project = makeProject({
      "pages/api/ping.ts": `export default function handler(req, res) { res.json({ ok: true }); }`,
    });
    expect(mapApiRouteHandlers(project, ABS_ROOT)).toEqual([]);
  });

  it("derives the real URL for a nested route file, stripping the app/ prefix and /route.ts suffix", () => {
    const project = makeProject({
      "app/api/shop/checkout/route.ts": `export async function POST() { return null; }`,
    });
    expect(mapApiRouteHandlers(project, ABS_ROOT)[0].url).toBe("/api/shop/checkout");
  });

  it("only reports HTTP methods the file actually exports — no phantom handlers", () => {
    const project = makeProject({
      "app/api/invoices/reset/route.ts": `export async function POST() { return null; }`,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(handlers.map((h) => h.method)).toEqual(["POST"]);
  });

  it("is deterministic — sorted by url then method", () => {
    const project = makeProject({
      "app/api/b/route.ts": `export async function POST() { return null; } export async function GET() { return null; }`,
      "app/api/a/route.ts": `export async function GET() { return null; }`,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(handlers.map((h) => `${h.method} ${h.url}`)).toEqual(["GET /api/a", "GET /api/b", "POST /api/b"]);
  });
});

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { mapApiRouteHandlers } from "./l1-api-routes";
import { extractBusinessRules } from "./l1-business-rules";

const ABS_ROOT = "/repo";

function makeProject(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [rel, content] of Object.entries(files)) {
    project.createSourceFile(`${ABS_ROOT}/${rel}`, content);
  }
  return project;
}

describe("extractBusinessRules", () => {
  it("captures a guard written directly in the route handler's own body — the common, real case (required-field checks)", () => {
    const project = makeProject({
      "app/api/board/cards/route.ts": `
        import { NextResponse } from "next/server";
        export async function POST(req) {
          const body = await req.json();
          if (!body.toColumnId) return NextResponse.json({ error: "missing toColumnId" }, { status: 400 });
          return NextResponse.json({ ok: true });
        }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);

    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules).toEqual([
      {
        functionName: "POST /api/board/cards",
        condition: "!body.toColumnId",
        consequence: 'return NextResponse.json({ error: "missing toColumnId" }, { status: 400 });',
        source: "app/api/board/cards/route.ts",
      },
    ]);
  });

  it("captures a real domain guard found inside a CALLED function — the placeOrder/isLoggedIn shape found live in demo-app", () => {
    const project = makeProject({
      "lib/shop.ts": `
        export function isLoggedIn() { return false; }
        export function placeOrder(email, address) {
          if (!isLoggedIn()) return null;
          return { id: "order-1" };
        }
      `,
      "app/api/shop/checkout/route.ts": `
        import { NextResponse } from "next/server";
        import { placeOrder } from "../../../../lib/shop";
        export async function POST(req) {
          const order = placeOrder("a@b.com", "1 Main St");
          return NextResponse.json(order);
        }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);

    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules).toContainEqual({
      functionName: "placeOrder",
      condition: "!isLoggedIn()",
      consequence: "return null;",
      source: "lib/shop.ts",
    });
  });

  it("treats a braced single-statement then-branch the same as a bare one", () => {
    const project = makeProject({
      "lib/x.ts": `export function guarded() { if (!ok()) { return null; } return 1; }`,
      "app/api/things/route.ts": `
        import { guarded } from "../../../lib/x";
        export async function POST() { guarded(); return null; }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules).toContainEqual({ functionName: "guarded", condition: "!ok()", consequence: "return null;", source: "lib/x.ts" });
  });

  it("skips a multi-statement then-branch — a guard with real side effects isn't summarized as one simple condition", () => {
    const project = makeProject({
      "lib/x.ts": `
        export function guarded() {
          if (!ok()) {
            logSomething();
            return null;
          }
          return 1;
        }
      `,
      "app/api/things/route.ts": `
        import { guarded } from "../../../lib/x";
        export async function POST() { guarded(); return null; }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules.some((r) => r.functionName === "guarded")).toBe(false);
  });

  it("captures a throw consequence, not just return", () => {
    const project = makeProject({
      "lib/x.ts": `export function guarded(type) { if (type === "bad") throw new Error("unknown type"); return 1; }`,
      "app/api/things/route.ts": `
        import { guarded } from "../../../lib/x";
        export async function POST() { guarded("x"); return null; }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules).toContainEqual({ functionName: "guarded", condition: 'type === "bad"', consequence: 'throw new Error("unknown type");', source: "lib/x.ts" });
  });

  it("dedupes a guarded function called from multiple routes — one real rule, not one per caller", () => {
    const project = makeProject({
      "lib/x.ts": `export function guarded() { if (!ok()) return null; return 1; }`,
      "app/api/a/route.ts": `import { guarded } from "../../../lib/x"; export async function POST() { guarded(); return null; }`,
      "app/api/b/route.ts": `import { guarded } from "../../../lib/x"; export async function POST() { guarded(); return null; }`,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    const rules = extractBusinessRules(project, ABS_ROOT, handlers);

    expect(rules.filter((r) => r.functionName === "guarded")).toHaveLength(1);
  });

  it("a handler with no guards anywhere (route or called functions) yields no rules — the honest, common case", () => {
    const project = makeProject({
      "lib/invoices.ts": `export function createInvoice() { return { id: "1" }; }`,
      "app/api/invoices/route.ts": `
        import { NextResponse } from "next/server";
        import { createInvoice } from "../../../lib/invoices";
        export async function POST() { return NextResponse.json(createInvoice()); }
      `,
    });
    const handlers = mapApiRouteHandlers(project, ABS_ROOT);
    expect(extractBusinessRules(project, ABS_ROOT, handlers)).toEqual([]);
  });

  it("returns an empty array for no handlers at all", () => {
    const project = makeProject({ "app/api/x/route.ts": `export async function GET() { return null; }` });
    expect(extractBusinessRules(project, ABS_ROOT, [])).toEqual([]);
  });
});

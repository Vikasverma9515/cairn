// L1 addendum — API route handlers (Phase 4, layer 6 of the deep-runtime-
// context plan: "which pages/components call which APIs"). Still pure AST
// facts, still deterministic: resolves an HTTP-method export
// (`export async function POST() {}` or `export const POST = async () =>
// {}`) in a Next.js App Router `app/api/**/route.ts` file to the real,
// imported, project-local function names its body actually calls — e.g.
// `app/api/invoices/route.ts`'s `POST` calling `createInvoice()` from
// `lib/invoices.ts`. This is the second hop of a real dependency graph
// whose first hop (a click's onClick -> a `fetch(url, {method})` call)
// l1-scan.ts's findApiCallIn/resolveHandlerCall already trace — connecting
// the two tells the agent not just THAT a button calls POST /api/invoices,
// but WHAT REAL CODE actually runs when it does.
//
// Deliberately App Router only (`app/api/**/route.ts`) — Pages Router API
// routes (`pages/api/*.ts`) export one default handler that dispatches on
// `req.method` internally, a materially different (and less statically
// clean) shape; skipped rather than guessed at, same "only claim what's
// genuinely traceable" discipline as l1-data-shapes.ts's own explicit-
// return-type-only boundary.

import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { Project, SourceFile } from "ts-morph";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiRouteHandler {
  method: HttpMethod;
  /** The real route this handler serves, e.g. "/api/invoices". */
  url: string;
  file: string;
  /** Real, imported, project-local function names this handler's body calls — deduped, sorted. Empty when the handler exists but calls nothing traceable (e.g. only NextResponse.json(...) directly). */
  calls: string[];
}

export function mapApiRouteHandlers(project: Project, absRoot: string): ApiRouteHandler[] {
  const handlers: ApiRouteHandler[] = [];

  for (const sf of project.getSourceFiles()) {
    const url = deriveApiRoute(absRoot, sf.getFilePath());
    if (!url) continue;

    const file = toPosix(path.relative(absRoot, sf.getFilePath()));
    const exported = sf.getExportedDeclarations();

    for (const method of HTTP_METHODS) {
      const decls = exported.get(method);
      if (!decls || decls.length === 0) continue;

      const calls = new Set<string>();
      for (const decl of decls) {
        const body = getCallableBody(decl);
        if (!body) continue;
        for (const name of tracedCallsIn(sf, body)) calls.add(name);
      }

      handlers.push({ method, url, file, calls: Array.from(calls).sort() });
    }
  }

  return handlers.sort((a, b) => (a.url === b.url ? a.method.localeCompare(b.method) : a.url.localeCompare(b.url)));
}

/** App Router convention only: app/api/**\/route.ts -> /api/... . Null for anything else (Pages Router API, a non-route.ts file, a route.ts outside app/api/). */
function deriveApiRoute(absRoot: string, filePath: string): string | null {
  const rel = toPosix(path.relative(absRoot, filePath));
  if (!rel.startsWith("app/api/")) return null;
  if (!/\/route\.(ts|js)$/.test(rel)) return null;
  return "/" + rel.slice("app/".length).replace(/\/route\.(ts|js)$/, "");
}

/** Exported for reuse by l1-business-rules.ts (Phase 4 layer 3) — the same "get the actual callable node, whichever of function-declaration/arrow/function-expression shape it is" resolution, not a second copy. */
export function getCallableBody(decl: Node): Node | null {
  if (Node.isFunctionDeclaration(decl) || Node.isArrowFunction(decl) || Node.isFunctionExpression(decl)) return decl;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) return init;
  }
  return null;
}

/** Real, imported, project-local function names called anywhere in `body` — same "identifier callee, resolves to a named import whose module isn't node_modules" filter l1-data-shapes.ts's resolveImportedFunction uses, so a library/global call (NextResponse.json, db.prepare) is never mistaken for app logic. */
function tracedCallsIn(sf: SourceFile, body: Node): string[] {
  const names = new Set<string>();
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee)) continue;
    if (resolvesToProjectFunction(sf, callee.getText())) names.add(callee.getText());
  }
  return Array.from(names);
}

function resolvesToProjectFunction(sf: SourceFile, name: string): boolean {
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
    if (!named) continue;
    const target = imp.getModuleSpecifierSourceFile();
    if (!target || target.getFilePath().includes("node_modules")) continue;
    return true;
  }
  return false;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

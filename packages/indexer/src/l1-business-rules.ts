// L1 addendum — business rules & validation constraints (Phase 4, layer 3
// of the deep-runtime-context plan: "legal state transitions, validation
// constraints, permission/role gating... without this the agent can
// attempt actions that are structurally possible to click but
// semantically invalid"). Still pure AST facts, still deterministic.
//
// Real research before writing this (an Explore-agent pass over
// examples/demo-app's actual mutating functions) found the honest truth:
// this app has almost NOTHING resembling a real domain rule — its
// mutating functions (archiveInvoice, moveCard, updateCard) apply
// unconditionally, no transition/permission logic anywhere. The one real
// exception, `lib/shop.ts`'s `placeOrder`, gates on `isLoggedIn()`. What
// IS genuinely common and real: every API route's own required-field/
// not-found guards (`if (!body.email) return NextResponse.json(...)`).
// This extractor reports BOTH kinds uniformly, as "a real guard this
// function enforces" — it does not, and cannot, reliably tell a domain
// permission check apart from an input-validation check by AST shape
// alone; that distinction is left to whoever reads the result.
//
// Deliberately reuses l1-api-routes.ts's own already-proven traversal
// (which route handler exports which HTTP method, which real functions
// it calls) rather than re-deriving it — resolveImportedFunction is
// l1-data-shapes.ts's own real declaration resolver, getCallableBody is
// l1-api-routes.ts's own callable-node resolver; both exported for this,
// not duplicated.

import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { Project } from "ts-morph";
import { resolveImportedFunction } from "./l1-data-shapes";
import { getCallableBody, type ApiRouteHandler } from "./l1-api-routes";

export interface BusinessRule {
  /** The real function this guard was found in — a route handler itself, or a function it calls. */
  functionName: string;
  /** The guard's real condition, source text verbatim, e.g. "!isLoggedIn()" or "!body.email". */
  condition: string;
  /** What happens if the condition is true — real source text of the single return/throw statement. */
  consequence: string;
  source: string;
}

export function extractBusinessRules(project: Project, absRoot: string, handlers: readonly ApiRouteHandler[]): BusinessRule[] {
  const rules: BusinessRule[] = [];
  const seen = new Set<string>(); // dedupe: the same guarded function can be called from several routes

  for (const handler of handlers) {
    const sf = project.getSourceFile(path.join(absRoot, handler.file));
    if (!sf) continue;

    // Guards written directly in the route handler's own body — the
    // common, real case in practice (required-field/not-found checks).
    const handlerDecl = sf.getExportedDeclarations().get(handler.method)?.[0];
    const handlerBody = handlerDecl ? getCallableBody(handlerDecl) : null;
    if (handlerBody) collect(`${handler.method} ${handler.url}`, handlerBody, handler.file, rules, seen);

    // Guards inside a real function this handler calls — the rarer,
    // more genuinely domain-flavored case (e.g. placeOrder's isLoggedIn check).
    for (const callName of handler.calls) {
      const decl = resolveImportedFunction(sf, callName);
      const body = decl ? getCallableBody(decl) : null;
      if (!body) continue;
      const calleeSource = toPosixRel(absRoot, body.getSourceFile().getFilePath());
      collect(callName, body, calleeSource, rules, seen);
    }
  }

  return rules.sort((a, b) => (a.functionName === b.functionName ? a.condition.localeCompare(b.condition) : a.functionName.localeCompare(b.functionName)));
}

function collect(functionName: string, body: Node, source: string, rules: BusinessRule[], seen: Set<string>): void {
  for (const guard of findGuardClauses(body)) {
    const key = `${functionName}::${guard.condition}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rules.push({ functionName, condition: guard.condition, consequence: guard.consequence, source });
  }
}

/**
 * A "guard" = an `if` whose THEN branch is a single return/throw
 * statement (bare, or the sole statement in a `{ }` block) — the
 * syntactic shape both a real domain check and a plain input-validation
 * check share. A multi-statement then-branch is deliberately skipped —
 * a guard with real side effects beyond returning is a more complex
 * case this doesn't try to summarize as one simple condition/consequence
 * pair.
 */
function findGuardClauses(body: Node): { condition: string; consequence: string }[] {
  const results: { condition: string; consequence: string }[] = [];
  for (const ifStmt of body.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    const consequenceNode = unwrapSingleStatementBlock(ifStmt.getThenStatement());
    if (!consequenceNode) continue;
    if (Node.isReturnStatement(consequenceNode) || Node.isThrowStatement(consequenceNode)) {
      results.push({ condition: ifStmt.getExpression().getText(), consequence: consequenceNode.getText() });
    }
  }
  return results;
}

function unwrapSingleStatementBlock(stmt: Node): Node | null {
  if (Node.isBlock(stmt)) {
    const statements = stmt.getStatements();
    return statements.length === 1 ? statements[0] : null;
  }
  return stmt;
}

function toPosixRel(absRoot: string, absFile: string): string {
  return path.relative(absRoot, absFile).split(path.sep).join("/");
}

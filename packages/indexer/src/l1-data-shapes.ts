// L1 addendum — data shapes (Phase 4, layer 2 of the deep-runtime-context
// plan). Still pure AST facts, still deterministic: only EXPLICIT
// return-type annotations are read, never the type checker's inferred type
// (`getType()`), matching l1-scan.ts's own "read syntax, not semantics"
// discipline — a function without an explicit return-type annotation
// contributes nothing here rather than falling back to checker inference,
// which is slower and less stable across ts-morph/TS versions.
//
// Concretely: for every file reachable from a page (already computed by
// l1-scan.ts's walkImports), find calls to an imported function whose
// return type names an interface or object-shaped type alias, and report
// that type's real fields — e.g. `listInvoices(): Invoice[]` in
// lib/invoices.ts surfaces Invoice's real `status: "Paid" | "Overdue" |
// "Archived"` union onto the page that renders it, instead of the agent
// only ever seeing button labels.

import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { InterfaceDeclaration, Project, SourceFile, TypeAliasDeclaration } from "ts-morph";
import type { DataShape } from "@cairnvibe/core";

export function extractDataShapes(project: Project, absRoot: string, reachableAbsFiles: string[]): DataShape[] {
  const shapes = new Map<string, DataShape>();

  for (const absFile of reachableAbsFiles) {
    const sf = project.getSourceFile(absFile);
    if (!sf) continue;

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee)) continue;

      const decl = resolveImportedFunction(sf, callee.getText());
      if (!decl) continue;

      const shape = shapeFromReturnType(decl, absRoot);
      if (shape && !shapes.has(shape.name)) shapes.set(shape.name, shape);
    }
  }

  return Array.from(shapes.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Finds the declaration an imported identifier resolves to — a top-level function or a const-assigned arrow/function expression — in its own module. */
function resolveImportedFunction(sf: SourceFile, name: string): Node | undefined {
  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === name);
    if (!named) continue;
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue;

    const realName = named.getName();
    const fn = target.getFunctions().find((f) => f.getName() === realName);
    if (fn) return fn;
    return target.getVariableDeclarations().find((d) => d.getName() === realName);
  }
  return undefined;
}

function shapeFromReturnType(decl: Node, absRoot: string): DataShape | null {
  let returnTypeNode: Node | undefined;
  if (Node.isFunctionDeclaration(decl)) {
    returnTypeNode = decl.getReturnTypeNode();
  } else if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
      returnTypeNode = init.getReturnTypeNode();
    }
  }
  if (!returnTypeNode) return null;

  const typeName = baseTypeName(returnTypeNode);
  if (!typeName) return null;

  const found = findTypeDeclaration(returnTypeNode.getSourceFile(), typeName);
  if (!found) return null;

  if (found.iface) {
    const iface = found.iface;
    const fields = iface
      .getProperties()
      .map((p) => ({ name: p.getName(), type: p.getTypeNode()?.getText() ?? "unknown", optional: p.hasQuestionToken() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { name: iface.getName(), fields, source: toPosixRel(absRoot, iface.getSourceFile().getFilePath()) };
  }

  const alias = found.alias!;
  const aliasTypeNode = alias.getTypeNode();
  if (!aliasTypeNode || !Node.isTypeLiteral(aliasTypeNode)) return null; // union/primitive aliases aren't a "shape" — no fields to report
  const fields = aliasTypeNode
    .getMembers()
    .filter(Node.isPropertySignature)
    .map((p) => ({ name: p.getName(), type: p.getTypeNode()?.getText() ?? "unknown", optional: p.hasQuestionToken() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { name: alias.getName(), fields, source: toPosixRel(absRoot, alias.getSourceFile().getFilePath()) };
}

/**
 * A return-type annotation (`BoardColumn[]`) very often names a type that's
 * only IMPORTED into this file, not declared here — types split into their
 * own `*-types.ts` module is a common real convention (this repo's own
 * demo-app does it, for a real reason: keeping a server-only db import out
 * of a "use client" component's bundle). Falls back to the file's own
 * imports, one hop, before giving up — not a general module-resolution
 * walk, just enough to cover the common "split types file" shape.
 */
function findTypeDeclaration(
  sf: SourceFile,
  typeName: string,
): { iface: InterfaceDeclaration; alias?: undefined } | { iface?: undefined; alias: TypeAliasDeclaration } | null {
  const localIface = sf.getInterface(typeName);
  if (localIface) return { iface: localIface };
  const localAlias = sf.getTypeAlias(typeName);
  if (localAlias) return { alias: localAlias };

  for (const imp of sf.getImportDeclarations()) {
    const named = imp.getNamedImports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === typeName);
    if (!named) continue;
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue;

    const realName = named.getName();
    const iface = target.getInterface(realName);
    if (iface) return { iface };
    const alias = target.getTypeAlias(realName);
    if (alias) return { alias };
  }
  return null;
}

/** Strips `[]` and a `| null` / `| undefined` union member, then requires a plain named type reference (no generics like `Promise<X>` — out of scope for v1). */
function baseTypeName(typeNode: Node): string | null {
  let node = typeNode;
  if (Node.isArrayTypeNode(node)) {
    node = node.getElementTypeNode();
  }
  if (Node.isUnionTypeNode(node)) {
    const members = node.getTypeNodes().filter((n) => n.getText() !== "null" && n.getText() !== "undefined");
    if (members.length !== 1) return null;
    node = members[0];
    if (Node.isArrayTypeNode(node)) node = node.getElementTypeNode();
  }
  if (Node.isTypeReference(node)) {
    return node.getTypeName().getText();
  }
  return null;
}

function toPosixRel(absRoot: string, absFile: string): string {
  return path.relative(absRoot, absFile).split(path.sep).join("/");
}

// L1 — pure AST facts extraction. No LLM, no interpretation, no timestamps.
// Same source in must produce byte-identical `RawFacts` out (see
// scripts/check-determinism.sh). Every collection here is explicitly sorted
// before being returned so directory-listing order can never leak in.

import path from "node:path";
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { routeFromPagePath } from "./routes";
import type { InteractiveTag, RawElement, RawFacts, RawPage } from "./types";

const INTERACTIVE_TAGS = new Set<InteractiveTag>(["button", "a", "form", "input"]);
const DEFAULT_ROOTS = ["app", "components", "lib"];
// Next.js App Router files the framework invokes directly rather than a
// page.tsx importing them — they must count as reachability roots too, or
// L2 would flag every layout and API route handler as dead code.
const FRAMEWORK_SPECIAL_FILE_RE = /^(layout|loading|error|not-found|template|default|route)\.(tsx|ts|jsx|js)$/;

function isRelevant(filePath: string): boolean {
  return (
    !filePath.endsWith(".d.ts") &&
    !/\.(test|spec)\.(ts|tsx)$/.test(filePath)
  );
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

export function scanL1(rootDir: string): RawFacts {
  const absRoot = path.resolve(rootDir);

  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      esModuleInterop: true,
      target: ts.ScriptTarget.ES2022,
    },
  });

  const patterns = DEFAULT_ROOTS.map((dir) => toPosix(path.join(absRoot, dir, "**/*.{ts,tsx}")));
  project.addSourceFilesAtPaths(patterns);

  const allScannedFiles = project
    .getSourceFiles()
    .map((sf) => toPosix(path.relative(absRoot, sf.getFilePath())))
    .filter(isRelevant)
    .sort();

  const pageFiles = project
    .getSourceFiles()
    .filter((sf) => /(^|\/)page\.(tsx|ts)$/.test(toPosix(sf.getFilePath())) && isRelevant(sf.getFilePath()));

  const pages: RawPage[] = pageFiles.map((pageFile) => {
    const reachable = new Set<string>();
    const elements: RawElement[] = [];
    walkImports(pageFile, absRoot, reachable, elements, new Set());

    return {
      route: routeFromPagePath(absRoot, pageFile.getFilePath()),
      file: toPosix(path.relative(absRoot, pageFile.getFilePath())),
      reachableFiles: Array.from(reachable).sort(),
      elements: elements.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))),
    };
  });

  pages.sort((a, b) => a.route.localeCompare(b.route));

  const specialFiles = project
    .getSourceFiles()
    .filter((sf) => FRAMEWORK_SPECIAL_FILE_RE.test(path.basename(sf.getFilePath())) && isRelevant(sf.getFilePath()));

  const frameworkReachable = new Set<string>();
  const frameworkVisited = new Set<string>();
  for (const sf of specialFiles) {
    // Framework files can have their own interactive elements (e.g. nav
    // links in layout.tsx), but the manifest is page-scoped — there's no
    // home for those yet, so they're intentionally discarded here. See LATER.md.
    walkImports(sf, absRoot, frameworkReachable, [], frameworkVisited);
  }

  return {
    version: "1",
    pages,
    allScannedFiles,
    frameworkReachableFiles: Array.from(frameworkReachable).sort(),
  };
}

function walkImports(
  sf: SourceFile,
  absRoot: string,
  reachableRel: Set<string>,
  elements: RawElement[],
  visitedAbs: Set<string>,
): void {
  const abs = sf.getFilePath();
  if (visitedAbs.has(abs) || !isRelevant(abs)) return;
  visitedAbs.add(abs);

  const rel = toPosix(path.relative(absRoot, abs));
  reachableRel.add(rel);
  elements.push(...findInteractiveElements(sf, rel));

  for (const imp of sf.getImportDeclarations()) {
    const target = imp.getModuleSpecifierSourceFile();
    if (!target) continue; // unresolved: node_modules / path-alias we don't chase
    if (target.getFilePath().includes("node_modules")) continue;
    walkImports(target, absRoot, reachableRel, elements, visitedAbs);
  }
}

function findInteractiveElements(sf: SourceFile, relFile: string): RawElement[] {
  const results: RawElement[] = [];
  const nodes = [
    ...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];

  for (const node of nodes) {
    const tag = node.getTagNameNode().getText().toLowerCase();
    if (!INTERACTIVE_TAGS.has(tag as InteractiveTag)) continue;

    const attrs = node.getAttributes();
    const dataAi = getAttrStringValue(attrs, "data-ai");
    const ariaLabel = getAttrStringValue(attrs, "aria-label");
    const text = node.getKind() === SyntaxKind.JsxOpeningElement ? getElementText(node) : null;

    const handlerInit =
      getAttrInitializerNode(attrs, "onClick") ?? getAttrInitializerNode(attrs, "onSubmit");
    const handlerCall = resolveHandlerCall(sf, handlerInit);

    const line = node.getStartLineNumber();
    const id = dataAi ?? slugify(text ?? ariaLabel ?? `${tag}-${line}`);

    results.push({
      id,
      tag: tag as InteractiveTag,
      dataAi,
      ariaLabel,
      text,
      handlerCall,
      file: relFile,
      line,
    });
  }

  return results;
}

function getAttrStringValue(attrs: Node[], name: string): string | null {
  for (const attr of attrs) {
    if (!Node.isJsxAttribute(attr) || attr.getNameNode().getText() !== name) continue;
    const init = attr.getInitializer();
    if (!init) return "true";
    if (Node.isStringLiteral(init)) return init.getLiteralText();
    if (Node.isJsxExpression(init)) {
      const inner = init.getExpression();
      if (inner && Node.isStringLiteral(inner)) return inner.getLiteralText();
    }
  }
  return null;
}

function getAttrInitializerNode(attrs: Node[], name: string): Node | undefined {
  for (const attr of attrs) {
    if (Node.isJsxAttribute(attr) && attr.getNameNode().getText() === name) {
      return attr.getInitializer();
    }
  }
  return undefined;
}

function getElementText(opening: Node): string | null {
  const parent = opening.getParentIfKind(SyntaxKind.JsxElement);
  if (!parent) return null;
  const texts: string[] = [];
  for (const child of parent.getJsxChildren()) {
    if (Node.isJsxText(child)) {
      const t = child.getText().trim().replace(/\s+/g, " ");
      if (t) texts.push(t);
    }
  }
  const joined = texts.join(" ").trim();
  return joined.length > 0 ? joined : null;
}

function resolveHandlerCall(sf: SourceFile, initializer: Node | undefined): string | null {
  if (!initializer) return null;
  let expr: Node | undefined = initializer;
  if (Node.isJsxExpression(expr)) {
    expr = expr.getExpression();
  }
  if (!expr) return null;

  let target: Node = expr;
  if (Node.isIdentifier(expr)) {
    const fn = findNamedFunctionLike(sf, expr.getText());
    if (!fn) return null;
    target = fn;
  }

  return findApiCallIn(target);
}

/** Finds a function/arrow-function declared anywhere in the file (not just top-level — most handlers are nested inside the component). */
function findNamedFunctionLike(sf: SourceFile, name: string): Node | undefined {
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (fn.getName() === name) return fn;
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getName() === name) return decl;
  }
  return undefined;
}

function findApiCallIn(node: Node): string | null {
  for (const call of node.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const calleeExpr = call.getExpression();
    const exprText = calleeExpr.getText();

    if (exprText === "fetch") {
      const result = describeFetchCall(call);
      if (result) return result;
    } else if (Node.isPropertyAccessExpression(calleeExpr) && exprText.startsWith("axios.")) {
      const result = describeAxiosCall(call);
      if (result) return result;
    }
  }
  return null;
}

function describeFetchCall(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const args = call.getArguments();
  const urlArg = args[0];
  if (!urlArg) return null;
  const url = Node.isStringLiteral(urlArg) ? urlArg.getLiteralText() : urlArg.getText();

  let method = "GET";
  const optsArg = args[1];
  if (optsArg && Node.isObjectLiteralExpression(optsArg)) {
    const methodProp = optsArg.getProperty("method");
    if (methodProp && Node.isPropertyAssignment(methodProp)) {
      const init = methodProp.getInitializer();
      if (init && Node.isStringLiteral(init)) method = init.getLiteralText().toUpperCase();
    }
  }
  return `${method} ${url}`;
}

function describeAxiosCall(call: Node): string | null {
  if (!Node.isCallExpression(call)) return null;
  const calleeExpr = call.getExpression();
  if (!Node.isPropertyAccessExpression(calleeExpr)) return null;
  const method = calleeExpr.getName().toUpperCase();
  const args = call.getArguments();
  const urlArg = args[0];
  if (!urlArg) return null;
  const url = Node.isStringLiteral(urlArg) ? urlArg.getLiteralText() : urlArg.getText();
  return `${method} ${url}`;
}

function slugify(s: string): string {
  const slug = s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return slug || "element";
}

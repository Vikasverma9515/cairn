// L1 — pure AST facts extraction. No LLM, no interpretation, no timestamps.
// Same source in must produce byte-identical `RawFacts` out (see
// scripts/check-determinism.sh). Every collection here is explicitly sorted
// before being returned so directory-listing order can never leak in.

import path from "node:path";
import { Project, Node, SyntaxKind, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { routeFromPagePath, routeFromPagesRouterPath } from "./routes";
import { extractDataShapes } from "./l1-data-shapes";
import { mapApiRouteHandlers } from "./l1-api-routes";
import { extractInAppCopy } from "./l1-in-app-copy";
import { extractBusinessRules } from "./l1-business-rules";
import type { InteractiveTag, RawElement, RawFacts, RawPage } from "./types";

const INTERACTIVE_TAGS = new Set<InteractiveTag>(["button", "a", "form", "input"]);
const DEFAULT_ROOTS = ["app", "components", "lib", "pages"];
// Files the framework invokes directly rather than a page importing them —
// they must count as reachability roots too, or L2 would flag every layout,
// API route handler, and _app/_document as dead code.
const APP_ROUTER_SPECIAL_FILE_RE = /^(layout|loading|error|not-found|template|default|route)\.(tsx|ts|jsx|js)$/;
const PAGES_ROUTER_SPECIAL_FILE_RE = /^(_app|_document|_error|404|500)\.(tsx|ts|jsx|js)$/;
// Custom components matching this convention (e.g. <PrimaryButton onClick=...>)
// are treated as buttons — a heuristic, not real component resolution.
const BUTTON_LIKE_COMPONENT_RE = /Button$/;

function isFrameworkSpecialFile(absRoot: string, filePath: string): boolean {
  const rel = toPosix(path.relative(absRoot, filePath));
  if (rel.startsWith("pages/api/")) return true;
  const base = path.basename(filePath);
  if (rel.startsWith("pages/") && PAGES_ROUTER_SPECIAL_FILE_RE.test(base)) return true;
  return APP_ROUTER_SPECIAL_FILE_RE.test(base);
}

/** Which route (if any) a source file defines, and via which router convention. Null for anything that isn't a page. */
function deriveRoute(absRoot: string, filePath: string): string | null {
  const rel = toPosix(path.relative(absRoot, filePath));
  if (rel.startsWith("app/")) {
    return /(^|\/)page\.(tsx|ts)$/.test(rel) ? routeFromPagePath(absRoot, filePath) : null;
  }
  if (rel.startsWith("pages/")) {
    if (isFrameworkSpecialFile(absRoot, filePath)) return null;
    return routeFromPagesRouterPath(absRoot, filePath);
  }
  return null;
}

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
    .filter((sf) => isRelevant(sf.getFilePath()) && deriveRoute(absRoot, sf.getFilePath()) !== null);

  const pages: RawPage[] = pageFiles.map((pageFile) => {
    const reachable = new Set<string>();
    const elements: RawElement[] = [];
    walkImports(pageFile, absRoot, reachable, elements, new Set());

    const reachableAbsFiles = Array.from(reachable).map((rel) => path.join(absRoot, rel));

    return {
      route: deriveRoute(absRoot, pageFile.getFilePath())!,
      file: toPosix(path.relative(absRoot, pageFile.getFilePath())),
      reachableFiles: Array.from(reachable).sort(),
      elements: elements.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))),
      dataShapes: extractDataShapes(project, absRoot, reachableAbsFiles),
      inAppCopy: extractInAppCopy(project, reachableAbsFiles, (absPath) => toPosix(path.relative(absRoot, absPath))),
    };
  });

  pages.sort((a, b) => a.route.localeCompare(b.route));

  const specialFiles = project
    .getSourceFiles()
    .filter((sf) => isRelevant(sf.getFilePath()) && isFrameworkSpecialFile(absRoot, sf.getFilePath()));

  const frameworkReachable = new Set<string>();
  const frameworkElements: RawElement[] = [];
  const frameworkVisited = new Set<string>();
  for (const sf of specialFiles) {
    // Framework files (layout.tsx, _app.tsx, ...) can have their own
    // interactive elements — e.g. a nav bar — that render on every page but
    // aren't reachable from any single page.tsx. Collected separately so L3
    // can describe them once and the manifest can attach them to every page.
    walkImports(sf, absRoot, frameworkReachable, frameworkElements, frameworkVisited);
  }

  const apiRouteHandlers = mapApiRouteHandlers(project, absRoot);

  return {
    version: "1",
    pages,
    allScannedFiles,
    frameworkReachableFiles: Array.from(frameworkReachable).sort(),
    frameworkElements: frameworkElements.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file))),
    apiRouteHandlers,
    businessRules: extractBusinessRules(project, absRoot, apiRouteHandlers),
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
    const rawTag = node.getTagNameNode().getText();
    const lowerTag = rawTag.toLowerCase();
    const attrs = node.getAttributes();
    const onClickInit = getAttrInitializerNode(attrs, "onClick");
    const onSubmitInit = getAttrInitializerNode(attrs, "onSubmit");

    // Literal HTML elements first; then a couple of documented heuristics
    // for common component conventions (next/link, *Button wrappers) — not
    // full component resolution, see LATER.md.
    let bucket: InteractiveTag | null = null;
    if (INTERACTIVE_TAGS.has(lowerTag as InteractiveTag)) {
      bucket = lowerTag as InteractiveTag;
    } else if (rawTag === "Link") {
      bucket = "a";
    } else if (BUTTON_LIKE_COMPONENT_RE.test(rawTag) && onClickInit) {
      bucket = "button";
    }
    if (!bucket) continue;

    const dataAi = getAttrStringValue(attrs, "data-ai");
    const ariaLabel = getAttrStringValue(attrs, "aria-label");
    const text = node.getKind() === SyntaxKind.JsxOpeningElement ? getElementText(node) : null;

    let handlerCall = resolveHandlerCall(sf, onClickInit ?? onSubmitInit);
    if (!handlerCall && rawTag === "Link") {
      const href = getAttrStringValue(attrs, "href");
      if (href) handlerCall = `navigate ${href}`;
    }

    const line = node.getStartLineNumber();
    // Raw text/aria-label, NOT slugified, when there's no data-ai — the
    // runtime widget's findElement() ladder (element-ladder.ts) matches
    // aria-label and text exactly as they appear on the element (case/
    // whitespace-normalized, but never hyphenated). A slugified id like
    // "new-invoice" would never match a button whose actual text is "New
    // Invoice" — this was a real, live latent gap: crawl.ts's runtime-DOM
    // analyzer never had it (built after this one, with the ladder's real
    // matching rules in mind), and this fix brings the source-reading path
    // in line with it. Only the last-resort synthetic fallback (no data-ai,
    // no aria-label, no text at all — an icon-only button with no
    // accessible name) still gets slugified; that case was already
    // unfindable via the ladder regardless of formatting, so slugifying it
    // doesn't make anything newly broken, just keeps the id readable.
    const id = dataAi ?? text ?? ariaLabel ?? slugify(`${bucket}-${line}`);

    results.push({
      id,
      tag: bucket,
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

/** Exported for reuse by l1-in-app-copy.ts (Phase 4 layer 4) — the exact
 * same "read a JSX element's own text children" logic, not a second copy. */
export function getElementText(opening: Node): string | null {
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

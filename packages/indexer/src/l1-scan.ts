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
    const isOpeningTag = node.getKind() === SyntaxKind.JsxOpeningElement;
    const staticText = isOpeningTag ? getElementText(node) : null;
    const ternaryAlternatives = isOpeningTag ? getTernaryTextAlternatives(node) : null;
    // A toggle button's real text is a ternary the static scanner can't run
    // ({open ? "Cancel" : "Add Patient"}) — collectJsxText correctly skips it
    // (it can't guess which branch renders), which used to leave `text` null
    // and the element unidentifiable to the agent (id fell to a meaningless
    // "button-168", `does` to "unknown action"). Real, live-found case: VOXERA's
    // own Add-Patient toggle button, confirmed via a real agent run that gave
    // up ("I'm not sure how to help with that") specifically on this element.
    // Both ternary branches are real, human-authored strings, so both are
    // kept now instead of neither.
    // An <input> is always self-closing (isOpeningTag false), so
    // getElementText never has children text to read — every plain text
    // field with no data-ai/aria-label fell to a meaningless "input-N" id
    // and a guessed, near-zero-confidence `does`. Its placeholder (or name,
    // when it has no placeholder) IS the same kind of real, human-authored
    // signal getElementText reads for a button's own children — just an
    // attribute instead of text content. Real, live-found case: VOXERA's
    // own Add-Patient form fields, confirmed via a real agent run whose
    // fill steps failed with "Could not find that element on the page" —
    // findElement's own runtime ladder (element-ladder.ts) can match a
    // real placeholder now that one is actually captured here.
    const placeholderText = bucket === "input" ? getAttrStringValue(attrs, "placeholder") ?? getAttrStringValue(attrs, "name") : null;
    const text = staticText ?? placeholderText ?? (ternaryAlternatives ? ternaryAlternatives[0] : null);
    const textAlternatives = ternaryAlternatives;

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
      textAlternatives,
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
 * same "read a JSX element's own text" logic, not a second copy.
 *
 * Real, live-found bug this fixes: only DIRECT JsxText children were ever
 * read — an element whose label sits inside a wrapper (`<a><span><Icon/>
 * Go to Invoices</span></a>`, an extremely common real-world icon+label
 * pattern, confirmed live in examples/demo-app's own landing page) came
 * back with NO text at all. With no text and no aria-label, manifest.ts's
 * elementFallbackSelector had nothing to fall back to but the bare tag
 * name ("a") — a selector matching every link on the page, useless for
 * actually finding the ONE the manifest meant. That's the real, traced
 * cause of "Could not find that element on the page" repeating for the
 * landing page's own nav cards — not a runtime bug at all, a static-
 * analysis gap in how a label gets extracted in the first place. Now
 * recurses into nested JsxElement children (never into a JsxExpression's
 * `{dynamic value}` or a JsxSelfClosingElement icon, which have no real
 * static text to read) so any REAL, human-authored text anywhere inside
 * the element is found, no matter how deeply it's wrapped. */
// Real, live-found gap this cap closes: a card-shaped button — a heading
// plus its own description paragraph as TWO separate text-bearing children,
// a common real pattern (VOXERA's own "New Agent" dialog: "Describe it —
// I'll build it" next to a full sentence explaining what it does) —
// recursed correctly (both are real, human-authored text, same rule as the
// "About" link above) but got joined into one ~200-character id/label/
// selector: unwieldy for an LLM to reproduce exactly, and confirmed live to
// be part of why an agent given "create a new agent" clicked the dialog
// open once and then never managed to pick either card inside it. Capped
// at a real word boundary (never mid-word) so the result stays a genuine
// PREFIX of the element's actual text — findElement's own substring-match
// fallback (element-ladder.ts) still resolves it correctly; only the exact-
// match path relies on reproducing the label verbatim, and a short, real
// heading is far easier for a model to reproduce than a full paragraph.
const MAX_ELEMENT_TEXT_LENGTH = 80;

export function getElementText(opening: Node): string | null {
  const parent = opening.getParentIfKind(SyntaxKind.JsxElement);
  if (!parent) return null;
  const texts: string[] = [];
  collectJsxText(parent, texts);
  const joined = texts.join(" ").trim().replace(/\s+/g, " ");
  if (joined.length === 0) return null;
  if (joined.length <= MAX_ELEMENT_TEXT_LENGTH) return joined;
  const truncated = joined.slice(0, MAX_ELEMENT_TEXT_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated).trim();
}

function collectJsxText(element: import("ts-morph").JsxElement, texts: string[]): void {
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxText(child)) {
      const t = child.getText().trim().replace(/\s+/g, " ");
      if (t) texts.push(t);
    } else if (Node.isJsxElement(child)) {
      collectJsxText(child, texts);
    }
    // JsxSelfClosingElement (an icon like <FileText/>) and JsxExpression
    // (a dynamic value like {count}) are deliberately skipped — neither
    // has real static text to read, and a dynamic value must never be
    // guessed at.
  }
}

/** Reads every `{cond ? "A" : "B"}` toggle-label inside an element as a
 * real, static value — the one case collectJsxText deliberately refuses (it
 * can't know at scan time which branch renders). A real button commonly has
 * MORE than one such expression side by side (an icon ternary next to a
 * label ternary — VOXERA's own Add-Patient button:
 * `{open ? <X/> : <Plus/>} {open ? "Cancel" : "Add Patient"}`), so every
 * child is checked independently rather than requiring the whole element to
 * be one bare ternary; the icon one simply contributes nothing (its
 * branches are JSX elements, not literals) instead of voiding the label
 * one. Within a single ternary, every leaf of the (possibly nested, e.g.
 * `a ? "X" : b ? "Y" : "Z"`) conditional must resolve to a real string
 * literal — one unresolvable branch (a variable, a function call) means
 * THAT ternary is abandoned, never partially guessed, matching this file's
 * own "a dynamic value must never be guessed at" rule everywhere else.
 * Order is source order, so results stay deterministic across runs — see
 * this file's own determinism contract. */
function getTernaryTextAlternatives(opening: Node): string[] | null {
  const parent = opening.getParentIfKind(SyntaxKind.JsxElement);
  if (!parent) return null;
  const literals: string[] = [];
  collectTernaryLiterals(parent, literals);
  return literals.length > 0 ? literals : null;
}

function collectTernaryLiterals(element: import("ts-morph").JsxElement, out: string[]): void {
  for (const child of element.getJsxChildren()) {
    if (Node.isJsxExpression(child)) {
      const expr = child.getExpression();
      if (expr && Node.isConditionalExpression(expr)) {
        const branch: string[] = [];
        if (collectConditionalLiterals(expr, branch)) {
          for (const t of branch) if (!out.includes(t)) out.push(t);
        }
      }
    } else if (Node.isJsxElement(child)) {
      collectTernaryLiterals(child, out);
    }
  }
}

function collectConditionalLiterals(expr: Node, out: string[]): boolean {
  if (Node.isConditionalExpression(expr)) {
    return collectConditionalLiterals(expr.getWhenTrue(), out) && collectConditionalLiterals(expr.getWhenFalse(), out);
  }
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    const t = expr.getLiteralText().trim();
    if (!t) return false;
    if (!out.includes(t)) out.push(t);
    return true;
  }
  return false;
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

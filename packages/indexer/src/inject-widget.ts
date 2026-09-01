// `cairn setup`'s one departure from `init`'s "never touch an existing
// file" rule — but only for this one, narrow, reversible edit (adding an
// import + one JSX tag), and only ever via a real AST parse, never blind
// string splicing. Any structure this doesn't recognize falls back to
// printing the two-line manual instruction instead of guessing — the
// same "don't corrupt what you don't understand" discipline `init` uses
// for whole files, applied here at the node level.

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";

export interface InjectResult {
  injected: boolean;
  filePath?: string;
  reason?: string; // why not, when injected is false
}

const WIDGET_JSX = `<Copilot registeredActions={[]} onDo={(action, target) => { /* run it through your own auth */ }} />`;

function findLayoutFile(absDir: string, framework: "next-app-router" | "next-pages-router"): string | null {
  const candidates =
    framework === "next-app-router"
      ? ["app/layout.tsx", "app/layout.jsx"]
      : ["pages/_app.tsx", "pages/_app.jsx"];
  for (const c of candidates) {
    const p = path.join(absDir, c);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function injectWidget(dir: string, framework: "next-app-router" | "next-pages-router"): InjectResult {
  const absDir = path.resolve(dir);
  const target = findLayoutFile(absDir, framework);
  if (!target) {
    return { injected: false, reason: "no app/layout.tsx or pages/_app.tsx found — add <Copilot/> manually" };
  }

  const relTarget = path.relative(absDir, target) || target;
  const original = fs.readFileSync(target, "utf8");
  if (original.includes("@cairnvibe/sdk") || original.includes("<Copilot")) {
    return { injected: false, reason: `${relTarget} already references Copilot — leaving it alone` };
  }

  try {
    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, allowJs: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    });
    const sf = project.addSourceFileAtPath(target);

    const hasImport = sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === "@cairnvibe/sdk");
    if (!hasImport) {
      sf.addImportDeclaration({ moduleSpecifier: "@cairnvibe/sdk", namedImports: ["Copilot"] });
    }

    // `insertText` at a position, not `replaceWithText` on a node — the latter
    // asks ts-morph to structurally reconcile old vs. new trees, which fails
    // ("children of the old and new trees were expected to have the same
    // count") the moment the replacement text contains a whole new element
    // rather than equivalent-shaped content. Plain positional insertion has
    // no tree to reconcile, so it can't hit that class of error.
    let inserted = false;

    // App Router: insert right before </body>, wherever it is in the tree.
    const bodyOpening = sf
      .getDescendantsOfKind(SyntaxKind.JsxOpeningElement)
      .find((el) => el.getTagNameNode().getText() === "body");
    if (bodyOpening) {
      const closing = bodyOpening.getParentIfKind(SyntaxKind.JsxElement)?.getClosingElement();
      if (closing) {
        sf.insertText(closing.getStart(), `${WIDGET_JSX}\n      `);
        inserted = true;
      }
    }

    // App Router fallback: a custom layout with no literal <body> — drop it right after {children}.
    if (!inserted) {
      const childrenExpr = sf
        .getDescendantsOfKind(SyntaxKind.JsxExpression)
        .find((e) => e.getExpression()?.getText() === "children");
      if (childrenExpr) {
        sf.insertText(childrenExpr.getEnd(), `\n      ${WIDGET_JSX}`);
        inserted = true;
      }
    }

    // Pages Router: wrap the returned <Component .../> as a sibling inside a fragment,
    // wherever it sits (works whether or not it's already inside other providers).
    // Insert the closing half first so the earlier (opening-half) position isn't shifted yet.
    if (!inserted) {
      const componentTag = sf
        .getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)
        .find((el) => el.getTagNameNode().getText() === "Component");
      if (componentTag) {
        // Capture both positions before either insertText call — the node
        // reference goes stale ("removed or forgotten") the instant the
        // first insertion changes the source text underneath it.
        const start = componentTag.getStart();
        const end = componentTag.getEnd();
        sf.insertText(end, `\n      ${WIDGET_JSX}\n    </>`);
        sf.insertText(start, `<>\n      `);
        inserted = true;
      }
    }

    if (!inserted) {
      return { injected: false, reason: `couldn't find a safe spot in ${relTarget} — add <Copilot/> manually` };
    }

    sf.saveSync();
    return { injected: true, filePath: target };
  } catch (err) {
    // Never leave a half-written file — ts-morph only writes on saveSync(),
    // so a thrown error here means the original file on disk is untouched.
    return { injected: false, reason: `couldn't safely modify ${relTarget} (${(err as Error).message}) — add <Copilot/> manually` };
  }
}

// `cairn setup`'s one departure from `init`'s "never touch an existing
// file" rule — but only for this one, narrow, reversible edit (a new
// wrapper component file, plus one import + one JSX tag in the real
// layout), and only ever via a real AST parse, never blind string
// splicing. Any structure this doesn't recognize falls back to printing
// the two-line manual instruction instead of guessing — the same "don't
// corrupt what you don't understand" discipline `init` uses for whole
// files, applied here at the node level.
//
// Real bug this fixes, found by testing against an actual project, not
// a synthetic fixture: an earlier version inserted `<Copilot
// onDo={(action, target) => {...}} />` directly into app/layout.tsx.
// layout.tsx is a Server Component by default (App Router) — React
// Server Components cannot accept a plain inline function as a prop on
// a Client Component, which <Copilot/> is ("Event handlers cannot be
// passed to Client Component props"). The working example app
// (examples/demo-app/components/CopilotWithActions.tsx) already solved
// this the right way: a small "use client" wrapper component that
// *defines* onDo itself, so no function ever crosses the server/client
// boundary — layout.tsx only ever references the wrapper by name, with
// zero function props. This module now generates that same wrapper
// instead of inlining Copilot directly, for both App Router and Pages
// Router (Pages Router doesn't strictly need it — no RSC boundary
// there — but the same shape avoids a special case and matches the one
// real, working example this project has).

import fs from "node:fs";
import path from "node:path";
import { Project, SyntaxKind, ts } from "ts-morph";

export interface InjectResult {
  injected: boolean;
  filePath?: string;
  wrapperPath?: string;
  reason?: string; // why not, when injected is false
}

const WRAPPER_COMPONENT_NAME = "CairnCopilot";

function wrapperSource(voice: boolean): string {
  // Real bug this closes: choosing voice during `cairn setup` used to save a
  // DEEPGRAM_API_KEY that nothing ever read — the generated wrapper never
  // passed speakEndpoint/transcribeEndpoint/realtimeUrl, so the widget had
  // no way to know voice existed regardless of whether a valid key was
  // configured. These routes only exist when setup.ts asked init.ts to
  // scaffold them (voice: true) — never reference them here unwired to a
  // real backend. realtimeUrl points at the port `cairn-realtime --with`
  // (setup.ts rewrites the dev script to start it alongside next dev) —
  // without that, a widget with realtimeUrl set just fails to connect,
  // which reads as "voice doesn't work" with no clue why.
  const voiceProps = voice
    ? '\n      speakEndpoint="/api/copilot/speak"\n      transcribeEndpoint="/api/copilot/transcribe"\n      realtimeUrl="ws://localhost:3010"'
    : "";
  return `"use client";

import { Copilot } from "@cairnvibe/sdk";

// A small client wrapper so the layout/app file (a server component, for
// metadata etc.) never has to pass a function prop across the server/client
// boundary — see the comment in inject-widget.ts for why that fails.
export function ${WRAPPER_COMPONENT_NAME}() {
  return (
    <Copilot
      registeredActions={[]}
      onDo={(action, target) => {
        // run it through your own auth
      }}${voiceProps}
    />
  );
}
`;
}

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

function toPosixRelativeImport(fromFile: string, toFileNoExt: string): string {
  let rel = path.relative(path.dirname(fromFile), toFileNoExt).split(path.sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

export function injectWidget(
  dir: string,
  framework: "next-app-router" | "next-pages-router",
  options: { voice?: boolean } = {},
): InjectResult {
  const absDir = path.resolve(dir);
  const target = findLayoutFile(absDir, framework);
  if (!target) {
    return { injected: false, reason: "no app/layout.tsx or pages/_app.tsx found — add the widget manually" };
  }

  const relTarget = path.relative(absDir, target) || target;
  const original = fs.readFileSync(target, "utf8");
  if (original.includes(WRAPPER_COMPONENT_NAME) || original.includes("@cairnvibe/sdk") || original.includes("<Copilot")) {
    return { injected: false, reason: `${relTarget} already references the widget — leaving it alone` };
  }

  // The wrapper always matches the layout file's own extension (.tsx stays
  // .tsx, .jsx stays .jsx — a .tsx file dropped into a plain-JS project has
  // no type checker configured for it and would just confuse tooling).
  const ext = path.extname(target); // ".tsx" or ".jsx"
  const wrapperPath = path.join(absDir, "components", `${WRAPPER_COMPONENT_NAME}${ext}`);
  if (!fs.existsSync(wrapperPath)) {
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, wrapperSource(!!options.voice));
  }
  const importPath = toPosixRelativeImport(target, wrapperPath.slice(0, -ext.length));
  const widgetJsx = `<${WRAPPER_COMPONENT_NAME} />`;

  try {
    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, allowJs: true, esModuleInterop: true, target: ts.ScriptTarget.ES2022 },
    });
    const sf = project.addSourceFileAtPath(target);

    const hasImport = sf.getImportDeclarations().some((d) => d.getModuleSpecifierValue() === importPath);
    if (!hasImport) {
      sf.addImportDeclaration({ moduleSpecifier: importPath, namedImports: [WRAPPER_COMPONENT_NAME] });
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
        sf.insertText(closing.getStart(), `${widgetJsx}\n      `);
        inserted = true;
      }
    }

    // App Router fallback: a custom layout with no literal <body> — drop it right after {children}.
    if (!inserted) {
      const childrenExpr = sf
        .getDescendantsOfKind(SyntaxKind.JsxExpression)
        .find((e) => e.getExpression()?.getText() === "children");
      if (childrenExpr) {
        sf.insertText(childrenExpr.getEnd(), `\n      ${widgetJsx}`);
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
        sf.insertText(end, `\n      ${widgetJsx}\n    </>`);
        sf.insertText(start, `<>\n      `);
        inserted = true;
      }
    }

    if (!inserted) {
      return { injected: false, reason: `couldn't find a safe spot in ${relTarget} — add the widget manually` };
    }

    sf.saveSync();
    return { injected: true, filePath: target, wrapperPath };
  } catch (err) {
    // Never leave a half-written file — ts-morph only writes on saveSync(),
    // so a thrown error here means the original file on disk is untouched.
    // The wrapper component file, if it was just created, is still valid
    // and harmless on its own — it's just not referenced from anywhere yet.
    return { injected: false, reason: `couldn't safely modify ${relTarget} (${(err as Error).message}) — add the widget manually` };
  }
}

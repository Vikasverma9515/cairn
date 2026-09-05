// L1 addendum — in-app copy (Phase 4, layer 4 of the deep-runtime-context
// plan: "help text, tooltips, onboarding copy... real authored semantics
// to mine instead of only LLM-guessed purpose"). Still pure AST facts,
// still deterministic: walks a page's own reachable files (the same set
// l1-scan.ts already computes) for heading/paragraph JSX elements and
// extracts their real text content — the same JSX-text-reading logic
// l1-scan.ts already uses for an interactive element's own label, just
// applied to the NON-interactive elements around it.
//
// Confirmed real, not hypothetical, before writing this: examples/demo-app's
// own pages each open with a real, human-authored <h1>/<p> pair
// ("Invoices" / "Every invoice you've sent, with its status and amount.")
// that today's L3 LLM-generated purpose/title can only ever GUESS at,
// even though the real answer is sitting right there in the source.

import { SyntaxKind } from "ts-morph";
import type { Project } from "ts-morph";
import { getElementText } from "./l1-scan";

const COPY_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p"]);
type CopyTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "p";

export interface CopyBlock {
  tag: CopyTag;
  text: string;
  file: string;
  line: number;
}

/**
 * @param reachableAbsFiles Absolute paths, same set l1-scan.ts already
 * computed for this page (its own file plus every file it imports).
 * @param relPathOf Converts an absolute path back to the same repo-
 * relative, posix-separated form every other L1 fact uses — passed in
 * rather than reimplemented, so this module never has its own opinion
 * about path formatting.
 */
export function extractInAppCopy(project: Project, reachableAbsFiles: string[], relPathOf: (absPath: string) => string): CopyBlock[] {
  const blocks: CopyBlock[] = [];

  for (const absFile of reachableAbsFiles) {
    const sf = project.getSourceFile(absFile);
    if (!sf) continue;
    const relFile = relPathOf(absFile);

    const nodes = [...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];
    for (const node of nodes) {
      const tag = node.getTagNameNode().getText().toLowerCase();
      if (!COPY_TAGS.has(tag)) continue;
      // Self-closing copy elements (<p />) never carry text — only
      // getElementText's own JsxElement-children path can find any.
      if (node.getKind() !== SyntaxKind.JsxOpeningElement) continue;
      const text = getElementText(node);
      if (!text) continue;
      blocks.push({ tag: tag as CopyTag, text, file: relFile, line: node.getStartLineNumber() });
    }
  }

  return blocks.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
}

import { Project } from "ts-morph";
import { describe, expect, it } from "vitest";
import { extractInAppCopy } from "./l1-in-app-copy";

const ABS_ROOT = "/repo";

function makeProject(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [rel, content] of Object.entries(files)) {
    project.createSourceFile(`${ABS_ROOT}/${rel}`, content);
  }
  return project;
}

function abs(...rel: string[]): string[] {
  return rel.map((r) => `${ABS_ROOT}/${r}`);
}

const relPathOf = (absPath: string) => absPath.replace(`${ABS_ROOT}/`, "");

describe("extractInAppCopy", () => {
  it("extracts a real h1/p pair — the exact shape found live in examples/demo-app", () => {
    const project = makeProject({
      "app/invoices/page.tsx": `
        export default function Page() {
          return (
            <main>
              <h1>Invoices</h1>
              <p>Every invoice you've sent, with its status and amount.</p>
            </main>
          );
        }
      `,
    });

    const blocks = extractInAppCopy(project, abs("app/invoices/page.tsx"), relPathOf);

    expect(blocks).toEqual([
      { tag: "h1", text: "Invoices", file: "app/invoices/page.tsx", line: expect.any(Number) },
      { tag: "p", text: "Every invoice you've sent, with its status and amount.", file: "app/invoices/page.tsx", line: expect.any(Number) },
    ]);
  });

  it("returns results in real document order, by line number", () => {
    const project = makeProject({
      "app/page.tsx": `
        export default function Page() {
          return (
            <main>
              <p>Second paragraph, written first in the array check.</p>
              <h1>Actually the heading — but it's ABOVE in source</h1>
            </main>
          );
        }
      `,
    });

    // Deliberately checking against the REAL source order (h1 appears
    // after p in this fixture's text, so the h1 should sort AFTER).
    const blocks = extractInAppCopy(project, abs("app/page.tsx"), relPathOf);
    expect(blocks.map((b) => b.tag)).toEqual(["p", "h1"]);
  });

  it("captures copy from a page's reachable CHILD component, not just its own file", () => {
    const project = makeProject({
      "components/Header.tsx": `export function Header() { return <h1>Board</h1>; }`,
      "app/board/page.tsx": `
        import { Header } from "../../components/Header";
        export default function Page() {
          return <main><Header /><p>Track work across columns.</p></main>;
        }
      `,
    });

    const blocks = extractInAppCopy(project, abs("app/board/page.tsx", "components/Header.tsx"), relPathOf);

    expect(blocks.map((b) => ({ tag: b.tag, text: b.text, file: b.file }))).toEqual(
      expect.arrayContaining([
        { tag: "h1", text: "Board", file: "components/Header.tsx" },
        { tag: "p", text: "Track work across columns.", file: "app/board/page.tsx" },
      ]),
    );
  });

  it("ignores an empty heading/paragraph — nothing real to say", () => {
    const project = makeProject({
      "app/page.tsx": `export default function Page() { return <main><h1>   </h1></main>; }`,
    });
    expect(extractInAppCopy(project, abs("app/page.tsx"), relPathOf)).toEqual([]);
  });

  it("ignores tags outside the real copy set (a button's own text is a different concern entirely)", () => {
    const project = makeProject({
      "app/page.tsx": `export default function Page() { return <main><button>Click me</button><div>Some div text</div></main>; }`,
    });
    expect(extractInAppCopy(project, abs("app/page.tsx"), relPathOf)).toEqual([]);
  });

  it("a self-closing copy-tagged element (<p />) is skipped — it never carries text", () => {
    const project = makeProject({
      "app/page.tsx": `export default function Page() { return <main><p /><h1>Real Heading</h1></main>; }`,
    });
    const blocks = extractInAppCopy(project, abs("app/page.tsx"), relPathOf);
    expect(blocks).toEqual([{ tag: "h1", text: "Real Heading", file: "app/page.tsx", line: expect.any(Number) }]);
  });

  it("handles all heading levels h1-h6, not just h1", () => {
    const project = makeProject({
      "app/page.tsx": `
        export default function Page() {
          return <main><h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6></main>;
        }
      `,
    });
    const blocks = extractInAppCopy(project, abs("app/page.tsx"), relPathOf);
    expect(blocks.map((b) => b.tag)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6"]);
  });

  it("returns an empty array when no reachable file resolves in the project", () => {
    const project = makeProject({ "app/page.tsx": `export default function Page() { return null; }` });
    expect(extractInAppCopy(project, abs("does/not/exist.tsx"), relPathOf)).toEqual([]);
  });
});

// L1 output shape. Facts only — no interpretation, no LLM. Every field here
// must be derivable the same way on every run of the same source (the
// determinism regression test diffs this JSON byte-for-byte across two runs).

export type InteractiveTag = "button" | "a" | "form" | "input";

export interface RawElement {
  /** Stable id: the `data-ai` value if present, else a slug derived from text/line. */
  id: string;
  tag: InteractiveTag;
  dataAi: string | null;
  ariaLabel: string | null;
  text: string | null;
  /** Best-effort trace of the onClick/onSubmit handler to a fetch/axios/tRPC call. */
  handlerCall: string | null;
  file: string;
  line: number;
}

export interface RawPage {
  route: string;
  file: string;
  /** Every source file reachable from this route's entry point, including itself. */
  reachableFiles: string[];
  elements: RawElement[];
}

export interface RawFacts {
  version: "1";
  pages: RawPage[];
  /** All component files found under the scanned roots, for L2 dead-code diffing. */
  allScannedFiles: string[];
  /**
   * Files reachable from a Next.js framework entry point that isn't a
   * `page.tsx` — `layout.tsx`, `route.ts`, `loading.tsx`, etc. These are
   * invoked by the framework, not imported by any page, so they'd otherwise
   * look dead to L2.
   */
  frameworkReachableFiles: string[];
}

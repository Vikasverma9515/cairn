// L1 output shape. Facts only — no interpretation, no LLM. Every field here
// must be derivable the same way on every run of the same source (the
// determinism regression test diffs this JSON byte-for-byte across two runs).

import type { DataShape } from "@cairnvibe/core";
import type { ApiRouteHandler } from "./l1-api-routes";

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
  /** Real interface/type-alias shapes traced from data-fetching calls across this page's reachable files — see l1-data-shapes.ts. */
  dataShapes: DataShape[];
  /**
   * The page's rendered visible text — only set by crawl.ts's runtime-DOM
   * analyzer (crawl mode has no source file to read; l1-scan.ts's
   * static-analysis mode leaves this undefined and l3-describe.ts reads
   * `file` off disk instead).
   */
  renderedText?: string;
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
  /** Interactive elements found in those same framework files — present on every page, not attributable to just one. */
  frameworkElements: RawElement[];
  /** Deployment-wide, not per-page (a route isn't owned by one page) — see l1-api-routes.ts. Empty in crawl mode (no source file to read). */
  apiRouteHandlers: ApiRouteHandler[];
}

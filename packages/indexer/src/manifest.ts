import { execFileSync } from "node:child_process";
import type { ApiCall, Element, Manifest, Page } from "@cairnvibe/core";
import type { RawElement, RawFacts } from "./types";
import type { L2Result } from "./l2-reachability";
import type { ElementDescription } from "./llm";
import type { L3Result } from "./l3-describe";

export function assembleManifest(rootDir: string, facts: RawFacts, l2: L2Result, l3: L3Result): Manifest {
  const globalElements: Element[] = facts.frameworkElements.map((el) =>
    toManifestElement(el, l3.globalElements.find((e) => e.id === el.id), "present in the root layout"),
  );

  const pages: Page[] = facts.pages.map((rawPage) => {
    const desc = l3.descriptions.get(rawPage.route);

    const ownElements: Element[] = rawPage.elements.map((el) =>
      toManifestElement(el, desc?.elements.find((e) => e.id === el.id), `reachable from route ${rawPage.route}`),
    );

    return {
      id: slugifyRoute(rawPage.route),
      route: rawPage.route,
      file: rawPage.file,
      title: desc?.title ?? rawPage.route,
      purpose: desc?.purpose ?? "Unknown — no description generated for this page.",
      whenToUse: desc?.whenToUse ?? "Unknown — no description generated for this page.",
      confidence: desc?.confidence ?? 0,
      elements: [...ownElements, ...globalElements],
    };
  });

  return {
    version: "1",
    commit: getCommit(rootDir),
    generatedAt: new Date().toISOString(),
    pages,
    dead: l2.dead,
    conflicts: l2.conflicts,
  };
}

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Turns l1-scan's traced `"POST /api/items/${id}"`-shaped string into
 * structured, executable data — this is what lets a `do` action actually
 * run (verb-executor.ts) instead of only ever describing itself. Only
 * real mutating methods count as an action; `"navigate ..."` (a Link) and
 * a bare GET aren't "do" material — see ApiCallSchema's doc comment in
 * @cairnvibe/core for the safety reasoning (bounded to calls a human
 * developer already wrote and shipped, nothing invented at runtime).
 */
function parseApiCall(handlerCall: string | null): ApiCall | null {
  if (!handlerCall) return null;
  const spaceIndex = handlerCall.indexOf(" ");
  if (spaceIndex === -1) return null;
  const method = handlerCall.slice(0, spaceIndex);
  const url = handlerCall.slice(spaceIndex + 1);
  if (!MUTATING_METHODS.has(method) || !url) return null;
  return { method: method as ApiCall["method"], url };
}

function toManifestElement(el: RawElement, elDesc: ElementDescription | undefined, baseEvidence: string): Element {
  const evidence = [baseEvidence];
  if (el.handlerCall) evidence.push(`onClick calls ${el.handlerCall}`);
  if (el.dataAi) evidence.push(`has data-ai="${el.dataAi}"`);

  return {
    id: el.id,
    label: el.text ?? el.ariaLabel ?? el.dataAi ?? el.id,
    selector: el.dataAi ? `[data-ai='${el.dataAi}']` : elementFallbackSelector(el),
    fallbacks: buildFallbacks(el),
    does: elDesc?.does ?? "Unknown — no description generated for this element.",
    confidence: elDesc?.confidence ?? 0,
    evidence,
    apiCall: parseApiCall(el.handlerCall),
  };
}

function elementFallbackSelector(el: RawElement): string {
  if (el.ariaLabel) return `[aria-label='${el.ariaLabel}']`;
  if (el.text) return `${el.tag} >> text=${el.text}`;
  return el.tag;
}

function buildFallbacks(el: RawElement): string[] {
  const fallbacks: string[] = [];
  if (el.ariaLabel) fallbacks.push(`[aria-label='${el.ariaLabel}']`);
  if (el.text) fallbacks.push(`${el.tag} >> text=${el.text}`);
  return fallbacks;
}

function slugifyRoute(route: string): string {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/\//g, "-").replace(/[[\]]/g, "");
}

function getCommit(rootDir: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

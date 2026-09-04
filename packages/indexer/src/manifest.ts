import { execFileSync } from "node:child_process";
import type { ApiCall, Element, Manifest, Page } from "@cairnvibe/core";
import type { RawElement, RawFacts } from "./types";
import type { ApiRouteHandler } from "./l1-api-routes";
import type { L2Result } from "./l2-reachability";
import type { ElementDescription } from "./llm";
import type { L3Result } from "./l3-describe";

export function assembleManifest(rootDir: string, facts: RawFacts, l2: L2Result, l3: L3Result): Manifest {
  // Phase 4, layer 6 — keyed once per build, not per element, so
  // enriching every element's apiCall stays a cheap map lookup.
  const routeHandlersByKey = new Map(facts.apiRouteHandlers.map((h) => [`${h.method} ${h.url}`, h]));

  const globalElements: Element[] = facts.frameworkElements.map((el) =>
    toManifestElement(el, l3.globalElements.find((e) => e.id === el.id), "present in the root layout", routeHandlersByKey),
  );

  const pages: Page[] = facts.pages.map((rawPage) => {
    const desc = l3.descriptions.get(rawPage.route);

    const ownElements: Element[] = rawPage.elements.map((el) =>
      toManifestElement(el, desc?.elements.find((e) => e.id === el.id), `reachable from route ${rawPage.route}`, routeHandlersByKey),
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
      dataShapes: rawPage.dataShapes,
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
 * Turns l1-scan's traced `"POST /api/items"`-shaped string into structured,
 * executable data — this is what lets a `do` action actually run
 * (verb-executor.ts) instead of only ever describing itself. Only real
 * mutating methods count as an action; `"navigate ..."` (a Link) and a bare
 * GET aren't "do" material — see ApiCallSchema's doc comment in
 * @cairnvibe/core for the safety reasoning (bounded to calls a human
 * developer already wrote and shipped, nothing invented at runtime).
 *
 * Only accepts a clean, static, same-origin relative path. l1-scan.ts's URL
 * capture falls back to a call's raw source text when the first argument
 * isn't a plain string literal — for a template literal (a per-row action
 * built as `` `/api/items/${id}/archive` ``) that's literal backticks and a
 * "${...}" hole, not a real fetchable URL; for a bare identifier or some
 * other expression it isn't a URL at all. Rejecting both instead of
 * guessing at resolving them is what keeps this bounded to calls that are
 * actually safe to fire as-is — see ApiCallSchema's doc comment for the
 * real gap this leaves (per-row actions aren't auto-executable yet).
 */
export function parseApiCall(handlerCall: string | null): ApiCall | null {
  if (!handlerCall) return null;
  const spaceIndex = handlerCall.indexOf(" ");
  if (spaceIndex === -1) return null;
  const method = handlerCall.slice(0, spaceIndex);
  const url = handlerCall.slice(spaceIndex + 1);
  if (!MUTATING_METHODS.has(method) || !url) return null;
  if (!/^\/[a-zA-Z0-9/_.-]*$/.test(url)) return null;
  return { method: method as ApiCall["method"], url };
}

function toManifestElement(
  el: RawElement,
  elDesc: ElementDescription | undefined,
  baseEvidence: string,
  routeHandlersByKey: Map<string, ApiRouteHandler>,
): Element {
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
    apiCall: enrichApiCall(parseApiCall(el.handlerCall), routeHandlersByKey),
  };
}

/** Phase 4, layer 6 — attaches the real backend function name(s) that
 * actually run when this apiCall fires, when Cairn found and traced the
 * matching route handler (l1-api-routes.ts). Absent when no handler
 * matched — a route Cairn didn't scan, or one whose body called nothing
 * traceable — never invented. */
function enrichApiCall(apiCall: ApiCall | null, routeHandlersByKey: Map<string, ApiRouteHandler>): ApiCall | null {
  if (!apiCall) return null;
  const handler = routeHandlersByKey.get(`${apiCall.method} ${apiCall.url}`);
  if (!handler || handler.calls.length === 0) return apiCall;
  return { ...apiCall, handledBy: handler.calls };
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

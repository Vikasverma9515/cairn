import { execFileSync } from "node:child_process";
import type { Element, Manifest, Page } from "@cairn/core";
import type { RawElement, RawFacts, RawPage } from "./types";
import type { L2Result } from "./l2-reachability";
import type { L3Result } from "./l3-describe";

export function assembleManifest(rootDir: string, facts: RawFacts, l2: L2Result, l3: L3Result): Manifest {
  const pages: Page[] = facts.pages.map((rawPage) => {
    const desc = l3.descriptions.get(rawPage.route);

    const elements: Element[] = rawPage.elements.map((el) => {
      const elDesc = desc?.elements.find((e) => e.id === el.id);
      return {
        id: el.id,
        label: el.text ?? el.ariaLabel ?? el.dataAi ?? el.id,
        selector: el.dataAi ? `[data-ai='${el.dataAi}']` : elementFallbackSelector(el),
        fallbacks: buildFallbacks(el),
        does: elDesc?.does ?? "Unknown — no description generated for this element.",
        confidence: elDesc?.confidence ?? 0,
        evidence: buildEvidence(rawPage, el),
      };
    });

    return {
      id: slugifyRoute(rawPage.route),
      route: rawPage.route,
      file: rawPage.file,
      title: desc?.title ?? rawPage.route,
      purpose: desc?.purpose ?? "Unknown — no description generated for this page.",
      whenToUse: desc?.whenToUse ?? "Unknown — no description generated for this page.",
      confidence: desc?.confidence ?? 0,
      elements,
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

function buildEvidence(rawPage: RawPage, el: RawElement): string[] {
  const evidence = [`reachable from route ${rawPage.route}`];
  if (el.handlerCall) evidence.push(`onClick calls ${el.handlerCall}`);
  if (el.dataAi) evidence.push(`has data-ai="${el.dataAi}"`);
  return evidence;
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

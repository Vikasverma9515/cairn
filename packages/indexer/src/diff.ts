// "What changed" between two manifest builds — e.g. CI comparing the
// current build against the last one on main. Pure comparison, no I/O.

import type { Element, Manifest, Page } from "@cairnvibe/core";

export interface ElementChange {
  id: string;
  doesBefore: string;
  doesAfter: string;
  confidenceBefore: number;
  confidenceAfter: number;
}

export interface PageChange {
  route: string;
  purposeChanged: boolean;
  elementsAdded: string[];
  elementsRemoved: string[];
  elementsChanged: ElementChange[];
}

export interface ManifestDiff {
  pagesAdded: string[];
  pagesRemoved: string[];
  pagesChanged: PageChange[];
  deadAdded: string[];
  deadRemoved: string[];
}

export function diffManifests(before: Manifest, after: Manifest): ManifestDiff {
  const beforeByRoute = new Map(before.pages.map((p) => [p.route, p]));
  const afterByRoute = new Map(after.pages.map((p) => [p.route, p]));

  const pagesAdded = [...afterByRoute.keys()].filter((r) => !beforeByRoute.has(r)).sort();
  const pagesRemoved = [...beforeByRoute.keys()].filter((r) => !afterByRoute.has(r)).sort();

  const pagesChanged: PageChange[] = [];
  for (const [route, beforePage] of beforeByRoute) {
    const afterPage = afterByRoute.get(route);
    if (!afterPage) continue;
    const change = diffPage(beforePage, afterPage);
    if (change) pagesChanged.push(change);
  }
  pagesChanged.sort((a, b) => a.route.localeCompare(b.route));

  return {
    pagesAdded,
    pagesRemoved,
    pagesChanged,
    deadAdded: after.dead.filter((f) => !before.dead.includes(f)).sort(),
    deadRemoved: before.dead.filter((f) => !after.dead.includes(f)).sort(),
  };
}

function diffPage(before: Page, after: Page): PageChange | null {
  const beforeElements = new Map(before.elements.map((e) => [e.id, e]));
  const afterElements = new Map(after.elements.map((e) => [e.id, e]));

  const elementsAdded = [...afterElements.keys()].filter((id) => !beforeElements.has(id)).sort();
  const elementsRemoved = [...beforeElements.keys()].filter((id) => !afterElements.has(id)).sort();

  const elementsChanged: ElementChange[] = [];
  for (const [id, beforeEl] of beforeElements) {
    const afterEl = afterElements.get(id);
    if (!afterEl) continue;
    if (elementContentChanged(beforeEl, afterEl)) {
      elementsChanged.push({
        id,
        doesBefore: beforeEl.does,
        doesAfter: afterEl.does,
        confidenceBefore: beforeEl.confidence,
        confidenceAfter: afterEl.confidence,
      });
    }
  }
  elementsChanged.sort((a, b) => a.id.localeCompare(b.id));

  const purposeChanged = before.purpose !== after.purpose || before.whenToUse !== after.whenToUse;

  if (!purposeChanged && elementsAdded.length === 0 && elementsRemoved.length === 0 && elementsChanged.length === 0) {
    return null;
  }

  return { route: before.route, purposeChanged, elementsAdded, elementsRemoved, elementsChanged };
}

function elementContentChanged(a: Element, b: Element): boolean {
  return a.does !== b.does || a.confidence !== b.confidence;
}

export function formatDiffAsText(diff: ManifestDiff): string {
  const lines: string[] = [];

  if (diff.pagesAdded.length) lines.push(`+ pages added: ${diff.pagesAdded.join(", ")}`);
  if (diff.pagesRemoved.length) lines.push(`- pages removed: ${diff.pagesRemoved.join(", ")}`);

  for (const change of diff.pagesChanged) {
    lines.push(`~ ${change.route}:`);
    if (change.purposeChanged) lines.push(`    purpose/whenToUse changed`);
    for (const id of change.elementsAdded) lines.push(`    + element added: ${id}`);
    for (const id of change.elementsRemoved) lines.push(`    - element removed: ${id}`);
    for (const c of change.elementsChanged) {
      lines.push(`    ~ ${c.id}: "${c.doesBefore}" -> "${c.doesAfter}" (confidence ${c.confidenceBefore} -> ${c.confidenceAfter})`);
    }
  }

  if (diff.deadAdded.length) lines.push(`+ newly dead: ${diff.deadAdded.join(", ")}`);
  if (diff.deadRemoved.length) lines.push(`- no longer dead: ${diff.deadRemoved.join(", ")}`);

  return lines.length > 0 ? lines.join("\n") : "no changes";
}

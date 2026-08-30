// L2 — reachability + conflict adjudication. Deterministic graph walk over
// what L1 already found; the only non-source-derived input is git recency,
// used purely as a tertiary tiebreaker (never changes the L1 `scan` output,
// so it doesn't affect the determinism regression test).

import path from "node:path";
import { execFileSync } from "node:child_process";
import { Project, ts } from "ts-morph";
import type { Conflict } from "@cairn/core";
import type { RawFacts } from "./types";

export interface L2Result {
  dead: string[];
  conflicts: Conflict[];
}

export function computeL2(rootDir: string, facts: RawFacts): L2Result {
  const absRoot = path.resolve(rootDir);

  const reachable = new Set<string>();
  for (const page of facts.pages) {
    for (const f of page.reachableFiles) reachable.add(f);
  }
  for (const f of facts.frameworkReachableFiles) reachable.add(f);

  const dead = facts.allScannedFiles.filter((f) => !reachable.has(f)).sort();
  const conflicts = findConflicts(absRoot, facts.allScannedFiles, reachable);

  return { dead, conflicts };
}

function baseName(file: string): string {
  const name = path.basename(file).replace(/\.(tsx|ts)$/, "");
  return name.replace(/(V\d+|Copy|Old)$/i, "").toLowerCase();
}

function isRoutingFile(file: string): boolean {
  return /^(page|layout|route|loading|error|not-found|template)\.(tsx|ts)$/.test(path.basename(file));
}

function findConflicts(absRoot: string, allFiles: string[], reachable: Set<string>): Conflict[] {
  const groups = new Map<string, string[]>();
  for (const f of allFiles) {
    if (isRoutingFile(f)) continue;
    const key = baseName(f);
    const list = groups.get(key) ?? [];
    list.push(f);
    groups.set(key, list);
  }

  const inboundCounts = countInboundImports(absRoot, allFiles);

  const conflicts: Conflict[] = [];
  for (const candidates of groups.values()) {
    if (candidates.length < 2) continue;

    const scored = [...candidates].sort().map((file) => ({
      file,
      reachable: reachable.has(file),
      inbound: inboundCounts.get(file) ?? 0,
      recency: gitRecency(absRoot, file),
    }));

    scored.sort((a, b) => {
      if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
      if (a.inbound !== b.inbound) return b.inbound - a.inbound;
      if (a.recency !== b.recency) return b.recency - a.recency;
      return a.file.localeCompare(b.file);
    });

    const winner = scored[0];
    const loser = scored[1];
    const reasonParts = [
      winner.reachable ? "reachable from router" : "not reachable from router",
      `${winner.inbound} inbound import(s)`,
    ];
    if (loser && !loser.reachable && loser.inbound === 0) {
      reasonParts.push("other candidate has zero inbound imports and is unreachable");
    }

    conflicts.push({
      candidates: scored.map((s) => s.file),
      chose: winner.file,
      reason: reasonParts.join("; "),
      confidence: winner.reachable && winner.inbound > 0 ? 0.9 : winner.reachable ? 0.75 : 0.5,
    });
  }

  conflicts.sort((a, b) => a.chose.localeCompare(b.chose));
  return conflicts;
}

function countInboundImports(absRoot: string, allFiles: string[]): Map<string, number> {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, allowJs: true, esModuleInterop: true },
  });
  for (const f of allFiles) {
    project.addSourceFileAtPath(path.join(absRoot, f));
  }

  const counts = new Map<string, number>(allFiles.map((f) => [f, 0]));
  for (const sf of project.getSourceFiles()) {
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target) continue;
      const rel = path.relative(absRoot, target.getFilePath()).split(path.sep).join("/");
      if (counts.has(rel)) counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
  }
  return counts;
}

function gitRecency(absRoot: string, file: string): number {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", file], {
      cwd: absRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out ? parseInt(out, 10) : 0;
  } catch {
    return 0;
  }
}

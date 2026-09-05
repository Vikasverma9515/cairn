import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteSkillStore } from "./skill-store";
import type { Skill } from "@cairnvibe/core";

function fakeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "connect-nodes",
    name: "Connecting nodes on the workflow canvas",
    description: "How to wire two nodes together on this platform's canvas.",
    instructions: "The canvas connects nodes via a dropdown labeled 'connects to', not a drag gesture.",
    pattern: "canvas",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("createSqliteSkillStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-skills-"));
    dbPath = path.join(tmpDir, "skills.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the db file and its parent directory on first use", () => {
    const nested = path.join(tmpDir, "nested", "dir", "skills.db");
    const store = createSqliteSkillStore(nested);
    store.saveSkill("deployment-1", fakeSkill());
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("saves a Skill and reads it back in full via getSkill", () => {
    const store = createSqliteSkillStore(dbPath);
    store.saveSkill("deployment-1", fakeSkill());
    const skill = store.getSkill("deployment-1", "connect-nodes");
    expect(skill).toEqual(fakeSkill());
  });

  it("getSkill returns null for an id this scope never saved", () => {
    const store = createSqliteSkillStore(dbPath);
    expect(store.getSkill("deployment-1", "does-not-exist")).toBeNull();
  });

  it("saveSkill upserts by (scopeId, id) — a re-learned Skill replaces the old one, never a duplicate row", () => {
    const store = createSqliteSkillStore(dbPath);
    store.saveSkill("deployment-1", fakeSkill({ instructions: "old instructions" }));
    store.saveSkill("deployment-1", fakeSkill({ instructions: "new, updated instructions" }));
    expect(store.getSkill("deployment-1", "connect-nodes")?.instructions).toBe("new, updated instructions");
    expect(store.listSkillSummaries("deployment-1")).toHaveLength(1);
  });

  it("listSkillSummaries returns id/name/description/pattern only — never the full instructions, the real progressive-disclosure mechanism", () => {
    const store = createSqliteSkillStore(dbPath);
    store.saveSkill("deployment-1", fakeSkill());
    const summaries = store.listSkillSummaries("deployment-1");
    expect(summaries).toEqual([{ id: "connect-nodes", name: "Connecting nodes on the workflow canvas", description: "How to wire two nodes together on this platform's canvas.", pattern: "canvas" }]);
    expect(summaries[0]).not.toHaveProperty("instructions");
  });

  it("a Skill with no classified pattern stores/reads back pattern as undefined, not null or a crash", () => {
    const store = createSqliteSkillStore(dbPath);
    const { pattern, ...withoutPattern } = fakeSkill();
    void pattern;
    store.saveSkill("deployment-1", withoutPattern as Skill);
    expect(store.getSkill("deployment-1", "connect-nodes")?.pattern).toBeUndefined();
    expect(store.listSkillSummaries("deployment-1")[0].pattern).toBeUndefined();
  });

  it("real scope isolation — a Skill saved under one deployment scopeId never appears under another, same discipline as MemoryStore", () => {
    const store = createSqliteSkillStore(dbPath);
    store.saveSkill("deployment-1", fakeSkill());
    expect(store.listSkillSummaries("deployment-2")).toEqual([]);
    expect(store.getSkill("deployment-2", "connect-nodes")).toBeNull();
  });

  it("multiple Skills in the same scope all list, each with its own summary", () => {
    const store = createSqliteSkillStore(dbPath);
    store.saveSkill("deployment-1", fakeSkill());
    store.saveSkill("deployment-1", fakeSkill({ id: "search-tips", name: "Searching the catalog", description: "How search behaves here.", pattern: "search-filter" }));
    const summaries = store.listSkillSummaries("deployment-1");
    expect(summaries.map((s) => s.id).sort()).toEqual(["connect-nodes", "search-tips"]);
  });

  it("shares an already-open Database connection instead of always opening its own file", () => {
    const db = new Database(dbPath);
    const store = createSqliteSkillStore(db);
    store.saveSkill("deployment-1", fakeSkill());
    expect(store.getSkill("deployment-1", "connect-nodes")).not.toBeNull();
    db.close();
  });
});

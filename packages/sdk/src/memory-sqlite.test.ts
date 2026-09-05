import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteMemoryStore, formatArchivedFacts } from "./memory-sqlite";

describe("createSqliteMemoryStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-memory-"));
    dbPath = path.join(tmpDir, "memory.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the db file and its parent directory on first use", () => {
    const nested = path.join(tmpDir, "nested", "dir", "memory.db");
    const store = createSqliteMemoryStore(nested);
    store.recordTurn("user-1", "user", "hello");
    expect(fs.existsSync(nested)).toBe(true);
  });

  describe("facts — explicit remember, upsert by (scopeId, key)", () => {
    it("recalls a fact after remembering it", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.rememberFact("user-1", "preferredName", "Alex");
      expect(store.recallFact("user-1", "preferredName")).toBe("Alex");
    });

    it("returns null for a fact that was never remembered", () => {
      const store = createSqliteMemoryStore(dbPath);
      expect(store.recallFact("user-1", "nope")).toBeNull();
    });

    it("a second rememberFact for the same key overwrites — an upsert, never a duplicate row", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.rememberFact("user-1", "flakySelector", "the old #submit-btn was flaky");
      store.rememberFact("user-1", "flakySelector", "now stable, was a race condition in the old build");
      expect(store.recallFact("user-1", "flakySelector")).toBe("now stable, was a race condition in the old build");
      expect(Object.keys(store.recallFacts("user-1"))).toEqual(["flakySelector"]);
    });

    it("recallFacts returns every fact for a scope as key -> value", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.rememberFact("user-1", "a", "1");
      store.rememberFact("user-1", "b", "2");
      expect(store.recallFacts("user-1")).toEqual({ a: "1", b: "2" });
    });

    it("facts are isolated per scopeId — the actual point of this store", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.rememberFact("user-1", "preferredName", "Alex");
      store.rememberFact("user-2", "preferredName", "Sam");
      expect(store.recallFact("user-1", "preferredName")).toBe("Alex");
      expect(store.recallFact("user-2", "preferredName")).toBe("Sam");
    });
  });

  describe("turns — append-only, recency-ordered recall", () => {
    it("recentTurns returns turns oldest-first, ready to feed straight into a HistoryTurn[]-shaped array", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.recordTurn("user-1", "user", "archive my old invoices");
      store.recordTurn("user-1", "assistant", "done, archived 3 invoices");
      const turns = store.recentTurns("user-1");
      expect(turns.map((t) => ({ role: t.role, content: t.content }))).toEqual([
        { role: "user", content: "archive my old invoices" },
        { role: "assistant", content: "done, archived 3 invoices" },
      ]);
      expect(typeof turns[0].createdAt).toBe("string");
    });

    it("respects the limit, keeping the MOST RECENT turns, not the oldest", () => {
      const store = createSqliteMemoryStore(dbPath);
      for (let i = 1; i <= 5; i++) store.recordTurn("user-1", "user", `turn ${i}`);
      const turns = store.recentTurns("user-1", 2);
      expect(turns.map((t) => t.content)).toEqual(["turn 4", "turn 5"]);
    });

    it("turns are isolated per scopeId", () => {
      const store = createSqliteMemoryStore(dbPath);
      store.recordTurn("user-1", "user", "from user 1");
      store.recordTurn("user-2", "user", "from user 2");
      expect(store.recentTurns("user-1").map((t) => t.content)).toEqual(["from user 1"]);
      expect(store.recentTurns("user-2").map((t) => t.content)).toEqual(["from user 2"]);
    });

    it("an empty scope with no turns returns an empty array, not an error", () => {
      const store = createSqliteMemoryStore(dbPath);
      expect(store.recentTurns("never-seen")).toEqual([]);
    });
  });

  it("persists across separate store instances pointed at the same file — the actual point of this store", () => {
    const first = createSqliteMemoryStore(dbPath);
    first.rememberFact("user-1", "preferredName", "Alex");
    first.recordTurn("user-1", "user", "hello");

    // Simulates a process restart: a brand new store instance, same file.
    const second = createSqliteMemoryStore(dbPath);
    expect(second.recallFact("user-1", "preferredName")).toBe("Alex");
    expect(second.recentTurns("user-1").map((t) => t.content)).toEqual(["hello"]);
  });

  it("accepts an already-open Database connection instead of a path, for sharing with a consumer's own tables", () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE app_stuff (id INTEGER PRIMARY KEY)"); // simulates a consumer's own table
    const store = createSqliteMemoryStore(db);
    store.recordTurn("user-1", "user", "hi");

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["app_stuff", "cairn_memory_facts", "cairn_memory_turns"]));
    expect(store.recentTurns("user-1")).toHaveLength(1);
  });

  describe("Architecture Pillar 5 — tiered memory (Core/Recall/Archive)", () => {
    describe("Core tier — kept small on purpose, evicts to Archive instead of deleting", () => {
      it("stays under the cap: 20 facts all remain in Core, nothing archived", () => {
        const store = createSqliteMemoryStore(dbPath);
        for (let i = 1; i <= 20; i++) store.rememberFact("user-1", `key${i}`, `value${i}`);
        expect(Object.keys(store.recallFacts("user-1"))).toHaveLength(20);
        expect(store.recallArchivedFacts("user-1", "value1")).toEqual({});
      });

      it("the 21st fact evicts the least-recently-updated Core fact into Archive, not deletes it", () => {
        const store = createSqliteMemoryStore(dbPath);
        for (let i = 1; i <= 20; i++) store.rememberFact("user-1", `key${i}`, `value${i}`);
        store.rememberFact("user-1", "key21", "value21");

        const coreFacts = store.recallFacts("user-1");
        expect(Object.keys(coreFacts)).toHaveLength(20);
        expect(coreFacts.key1).toBeUndefined(); // the oldest-updated fact was evicted
        expect(coreFacts.key21).toBe("value21"); // the newest write is always kept

        // Evicted, not deleted — it's now reachable via the Archive tier.
        expect(store.recallArchivedFacts("user-1", "value1")).toEqual({ key1: "value1" });
      });

      it("re-remembering an EXISTING key never triggers eviction — it's an update, not growth", () => {
        const store = createSqliteMemoryStore(dbPath);
        for (let i = 1; i <= 20; i++) store.rememberFact("user-1", `key${i}`, `value${i}`);
        store.rememberFact("user-1", "key1", "updated value 1"); // re-write an existing key
        expect(Object.keys(store.recallFacts("user-1"))).toHaveLength(20);
        expect(store.recallFact("user-1", "key1")).toBe("updated value 1");
        expect(store.recallArchivedFacts("user-1", "value1")).toEqual({}); // nothing evicted
      });

      it("Core capping is isolated per scope — a busy scope never evicts a different scope's facts", () => {
        const store = createSqliteMemoryStore(dbPath);
        for (let i = 1; i <= 20; i++) store.rememberFact("user-1", `key${i}`, `value${i}`);
        store.rememberFact("user-1", "key21", "value21");
        store.rememberFact("user-2", "onlyFact", "still here");
        expect(store.recallFact("user-2", "onlyFact")).toBe("still here");
        expect(Object.keys(store.recallFacts("user-2"))).toHaveLength(1);
      });
    });

    describe("Recall tier — searchTurns, a real keyword match beyond recentTurns' own recency window", () => {
      it("finds an older turn a plain recentTurns(scopeId, small-limit) call would miss", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.recordTurn("user-1", "user", "the flaky selector on the checkout page was a real race condition");
        for (let i = 0; i < 10; i++) store.recordTurn("user-1", "user", `unrelated turn ${i}`);
        expect(store.recentTurns("user-1", 3).some((t) => t.content.includes("flaky selector"))).toBe(false);
        expect(store.searchTurns("user-1", "flaky selector").some((t) => t.content.includes("flaky selector"))).toBe(true);
      });

      it("matches on ANY significant word in the query, not requiring the whole phrase", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.recordTurn("user-1", "assistant", "archived the Globex invoice");
        expect(store.searchTurns("user-1", "find the globex record")).toHaveLength(1);
      });

      it("returns results newest-first-found but chronologically ordered, same convention as recentTurns", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.recordTurn("user-1", "user", "first mention of invoices");
        store.recordTurn("user-1", "user", "unrelated");
        store.recordTurn("user-1", "user", "second mention of invoices");
        const results = store.searchTurns("user-1", "invoices");
        expect(results.map((r) => r.content)).toEqual(["first mention of invoices", "second mention of invoices"]);
      });

      it("a query with no real significant words (too short/common) returns an empty array, never every turn", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.recordTurn("user-1", "user", "anything at all");
        expect(store.searchTurns("user-1", "a to it")).toEqual([]);
      });

      it("no match returns an empty array, not an error", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.recordTurn("user-1", "user", "hello there");
        expect(store.searchTurns("user-1", "invoices")).toEqual([]);
      });

      it("respects a real limit", () => {
        const store = createSqliteMemoryStore(dbPath);
        for (let i = 0; i < 5; i++) store.recordTurn("user-1", "user", `invoice mention ${i}`);
        expect(store.searchTurns("user-1", "invoice", 2)).toHaveLength(2);
      });
    });

    describe("Archive tier — long-term facts pulled in only when relevant, never always-injected", () => {
      it("archiveFact stores a fact directly, reachable only via recallArchivedFacts, never recallFacts", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.archiveFact("user-1", "oldPreference", "used to prefer dark mode before the redesign");
        expect(store.recallFacts("user-1")).toEqual({}); // never counted as a Core fact
        expect(store.recallArchivedFacts("user-1", "dark mode preference")).toEqual({ oldPreference: "used to prefer dark mode before the redesign" });
      });

      it("matches on either the key or the value", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.archiveFact("user-1", "flakySelector", "the old checkout button was unreliable");
        expect(store.recallArchivedFacts("user-1", "flakySelector")).toEqual({ flakySelector: "the old checkout button was unreliable" });
        expect(store.recallArchivedFacts("user-1", "checkout button")).toEqual({ flakySelector: "the old checkout button was unreliable" });
      });

      it("re-archiving the same key upserts rather than duplicating", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.archiveFact("user-1", "note", "first version");
        store.archiveFact("user-1", "note", "second, updated version");
        expect(store.recallArchivedFacts("user-1", "version")).toEqual({ note: "second, updated version" });
      });

      it("a query matching nothing returns an empty object, never a wrong guess", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.archiveFact("user-1", "note", "about invoices");
        expect(store.recallArchivedFacts("user-1", "kanban board")).toEqual({});
      });

      it("Archive is isolated per scope, same as every other tier", () => {
        const store = createSqliteMemoryStore(dbPath);
        store.archiveFact("user-1", "note", "user one's fact");
        expect(store.recallArchivedFacts("user-2", "fact")).toEqual({});
      });
    });

    it("survives a process restart — Archive tier persists across separate store instances, same as Core/Recall", () => {
      const first = createSqliteMemoryStore(dbPath);
      for (let i = 1; i <= 20; i++) first.rememberFact("user-1", `key${i}`, `value${i}`);
      first.rememberFact("user-1", "key21", "value21"); // evicts key1 to Archive

      const second = createSqliteMemoryStore(dbPath);
      expect(second.recallArchivedFacts("user-1", "value1")).toEqual({ key1: "value1" });
    });
  });
});

describe("formatArchivedFacts", () => {
  it("formats real archived facts with wording distinct from formatRememberedFacts, so the model can tell the tiers apart", () => {
    const text = formatArchivedFacts({ oldPreference: "used to prefer dark mode" });
    expect(text).toContain("archived");
    expect(text).toContain("oldPreference — used to prefer dark mode");
  });

  it("returns null for an empty fact set, so a caller can skip adding a turn at all", () => {
    expect(formatArchivedFacts({})).toBeNull();
  });
});

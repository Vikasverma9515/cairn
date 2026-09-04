import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteMemoryStore } from "./memory-sqlite";

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
});

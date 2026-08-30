import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSqliteMissesStore } from "./dashboard-sqlite";
import { createMissesHandler, summarizeMisses } from "./dashboard";

describe("createSqliteMissesStore", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-sqlite-"));
    dbPath = path.join(tmpDir, "misses.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the db file and its parent directory on first use", () => {
    const nested = path.join(tmpDir, "nested", "dir", "misses.db");
    const store = createSqliteMissesStore(nested);
    store.report({ attempted: "create-invoice", route: "/invoices" });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it("records and lists misses, same shape as the in-memory store", () => {
    const store = createSqliteMissesStore(dbPath);
    store.report({ attempted: "create-invoice", route: "/invoices" });
    const records = store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ attempted: "create-invoice", route: "/invoices" });
    expect(typeof records[0].at).toBe("string");
  });

  it("clear() empties the table", () => {
    const store = createSqliteMissesStore(dbPath);
    store.report({ attempted: "x", route: "/y" });
    store.clear();
    expect(store.list()).toEqual([]);
  });

  it("persists across separate store instances pointed at the same file — the actual point of this store", () => {
    const first = createSqliteMissesStore(dbPath);
    first.report({ attempted: "archive-inv-2", route: "/invoices" });

    // Simulates a process restart: a brand new store instance, same file.
    const second = createSqliteMissesStore(dbPath);
    expect(second.list()).toHaveLength(1);
    expect(second.list()[0]).toMatchObject({ attempted: "archive-inv-2", route: "/invoices" });
  });

  it("works through createMissesHandler and summarizeMisses exactly like the in-memory store", async () => {
    const store = createSqliteMissesStore(dbPath);
    const handler = createMissesHandler(store);

    await handler.post({ attempted: "create-invoice", route: "/invoices" });
    await handler.post({ attempted: "create-invoice", route: "/invoices" });

    const result = await handler.get();
    expect(result.body).toEqual(summarizeMisses(store.list()));
    expect(result.body).toEqual([{ attempted: "create-invoice", route: "/invoices", count: 2, lastSeen: expect.any(String) }]);
  });

  it("accepts an already-open Database connection instead of a path, for sharing with a consumer's own tables", () => {
    const db = new Database(dbPath);
    db.exec("CREATE TABLE app_stuff (id INTEGER PRIMARY KEY)"); // simulates a consumer's own table
    const store = createSqliteMissesStore(db);
    store.report({ attempted: "x", route: "/y" });

    // Both tables coexist in the same file/connection without collision.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["app_stuff", "cairn_misses"]));
    expect(store.list()).toHaveLength(1);
  });
});

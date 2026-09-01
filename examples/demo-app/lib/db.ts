// Single shared SQLite connection for the demo app — invoices and the
// failure-dashboard misses (via @cairnvibe/sdk/dashboard-sqlite) both live in
// this one file, so restarting the dev server no longer loses either.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const DB_PATH = path.join(process.cwd(), "data", "cairn-demo.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    client TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL
  )
`);

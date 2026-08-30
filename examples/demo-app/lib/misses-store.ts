// Persisted in SQLite (shares the connection from lib/db.ts) — survives
// restarts, unlike the in-memory default createMissesStore() would.
import { createMissesHandler } from "@cairn/sdk/dashboard";
import { createSqliteMissesStore } from "@cairn/sdk/dashboard-sqlite";
import { db } from "./db";

export const missesStore = createSqliteMissesStore(db);
export const missesHandler = createMissesHandler(missesStore);

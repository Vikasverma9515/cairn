// Shared singleton so the API route (writes) and the dashboard page (reads)
// see the same in-memory data within one server process.
import { createMissesHandler, createMissesStore } from "@cairn/sdk/dashboard";

export const missesStore = createMissesStore();
export const missesHandler = createMissesHandler(missesStore);

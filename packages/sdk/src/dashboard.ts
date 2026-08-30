// Server-side aggregation of the element-ladder misses the client already
// logs to localStorage (see element-ladder.ts). Opt-in: the Copilot widget
// only reports here if `reportMissesEndpoint` is set. Same
// build-a-handler-function shape as `createCopilotHandler` in server.ts.

export interface MissRecord {
  attempted: string;
  route: string;
  at: string;
}

export interface MissesStore {
  report(context: { attempted: string; route: string }): void;
  list(): MissRecord[];
  clear(): void;
}

/** In-memory store — fine for a demo or a single-instance deployment. Swap for a real one via the same interface. */
export function createMissesStore(): MissesStore {
  const records: MissRecord[] = [];
  return {
    report(context) {
      records.push({ ...context, at: new Date().toISOString() });
    },
    list() {
      return [...records];
    },
    clear() {
      records.length = 0;
    },
  };
}

export interface MissesSummary {
  attempted: string;
  route: string;
  count: number;
  lastSeen: string;
}

export function summarizeMisses(records: MissRecord[]): MissesSummary[] {
  const groups = new Map<string, MissesSummary>();
  for (const r of records) {
    const key = `${r.route}::${r.attempted}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (r.at > existing.lastSeen) existing.lastSeen = r.at;
    } else {
      groups.set(key, { attempted: r.attempted, route: r.route, count: 1, lastSeen: r.at });
    }
  }
  return Array.from(groups.values()).sort((a, b) => b.count - a.count);
}

function isValidMissReport(body: unknown): body is { attempted: string; route: string } {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return typeof candidate.attempted === "string" && typeof candidate.route === "string";
}

export interface MissesHandler {
  /** Wire to `POST` — the widget calls this on every lookup miss. */
  post(body: unknown): Promise<{ status: number; body: { ok: true } | { error: string } }>;
  /** Wire to `GET` — returns misses grouped by route+target with counts, most frequent first. */
  get(): Promise<{ status: number; body: MissesSummary[] }>;
}

export function createMissesHandler(store: MissesStore): MissesHandler {
  return {
    async post(body: unknown) {
      if (!isValidMissReport(body)) {
        return { status: 400, body: { error: "invalid miss report" } };
      }
      store.report(body);
      return { status: 200, body: { ok: true } };
    },
    async get() {
      return { status: 200, body: summarizeMisses(store.list()) };
    },
  };
}

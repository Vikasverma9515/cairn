// Round-robins across a comma-separated list of API keys (e.g. `GROQ_API_KEYS`)
// so runtime verb calls spread across several free-tier rate limits instead
// of hammering a single key. Mirrors packages/indexer/src/key-rotator.ts —
// small enough that duplicating it beats adding a shared package for it.
//
// Real, live-found gap this closes: a key that's genuinely invalid/expired
// (a real 401, confirmed directly against Groq's own API — not a transient
// rate limit) used to just keep getting handed out by `take()` on every
// pass through the rotation, forever, for the life of the process — a
// configured-but-dead key wasn't just wasted capacity, it actively
// sabotaged roughly (dead keys / total keys) of every real request, since
// GroqVerbLLM's own retry-on-a-different-key logic only ever triggered on
// a 429 (rate limit), never a 401 (dead key) — see server.ts's own
// isInvalidKeyError. `markDead` is the fix: once a caller confirms a key
// is genuinely invalid (not just rate-limited), it's excluded from
// rotation for the rest of THIS process's life — a session-scoped
// blocklist, not a persisted one, since a key's validity is checked fresh
// every time this module is loaded (no stale cross-process assumptions).
export class KeyRotator {
  private keys: string[];
  private next = 0;
  private deadKeys = new Set<string>();

  constructor(keys: string[]) {
    if (keys.length === 0) throw new Error("KeyRotator: at least one key is required");
    this.keys = keys;
  }

  static fromEnvList(value: string | undefined): KeyRotator | null {
    if (!value) return null;
    const keys = value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    return keys.length > 0 ? new KeyRotator(keys) : null;
  }

  /**
   * Round-robins across whichever keys haven't been confirmed dead yet.
   * If EVERY configured key has been marked dead (a real, if unlikely,
   * total outage or a fully-expired key set), falls back to rotating
   * across the full original list anyway — a bounded retry loop still
   * needs something real to try, and refusing to ever retry again would
   * turn "every key happens to be dead right now" into "permanently
   * broken for the rest of this process," which is strictly worse.
   */
  take(): string {
    const liveKeys = this.keys.filter((k) => !this.deadKeys.has(k));
    const pool = liveKeys.length > 0 ? liveKeys : this.keys;
    const key = pool[this.next % pool.length];
    this.next += 1;
    return key;
  }

  /**
   * Marks a key as confirmed invalid by the provider (not a rate limit) —
   * excluded from `take()`'s rotation for the rest of this process's life.
   * Logs once per key the first time it's marked, naming only its last 4
   * characters (never the real secret) and how many configured keys still
   * remain live, so a real deployment's own logs show exactly what
   * happened instead of a silent, confusing drop in capacity. The caller
   * decides what "confirmed invalid" means for its own provider (Groq: a
   * real 401; Gemini: a real 400 with `API_KEY_INVALID` — genuinely
   * different conventions, see server.ts's isInvalidKeyError/
   * isGeminiInvalidKeyError) — this class stays provider-agnostic on
   * purpose, so the log message doesn't name a specific status code.
   */
  markDead(key: string): void {
    if (this.deadKeys.has(key)) return;
    this.deadKeys.add(key);
    const remaining = this.keys.length - this.deadKeys.size;
    console.warn(`[cairn] API key ending in "${key.slice(-4)}" is invalid (confirmed by the provider) — excluded from rotation for the rest of this session. ${remaining} of ${this.keys.length} configured key(s) remain.`);
  }

  /** How many distinct keys are configured — callers use this to bound a
   * rate-limit retry loop (no point trying more times than there are
   * actual keys to fall back to). */
  get size(): number {
    return this.keys.length;
  }

  /** How many configured keys have NOT been marked dead — narrower than
   * `size` once markDead has actually excluded something; used to bound a
   * retry loop against only the keys genuinely worth trying right now. */
  get liveSize(): number {
    return this.keys.length - this.deadKeys.size;
  }
}

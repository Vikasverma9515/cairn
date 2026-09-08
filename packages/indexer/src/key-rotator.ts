// Round-robins across a comma-separated list of API keys (e.g. `GROQ_API_KEYS`)
// so a batch of L3 describe calls can spread across several free-tier rate
// limits instead of hammering a single key. Mirrors packages/sdk/src/
// key-rotator.ts — small enough that duplicating it beats adding a shared
// package for it.
//
// Real, live-found gap this closes (same one the sdk copy fixes): a key
// that's genuinely invalid/expired (a real 401 — see llm.ts's
// isInvalidKeyError) used to just keep getting handed out by `take()` on
// every pass through the rotation, forever, for the life of this `cairn
// build` process — wasting a real API round trip and a real retry
// attempt on a key already proven dead, over and over, on every page
// that happened to land on it. `markDead` excludes a confirmed-invalid
// key from rotation for the rest of THIS build.
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

  /** Round-robins across whichever keys haven't been confirmed dead yet.
   * Falls back to the full original list if every key has been marked
   * dead — a bounded retry loop still needs something real to try. */
  take(): string {
    const liveKeys = this.keys.filter((k) => !this.deadKeys.has(k));
    const pool = liveKeys.length > 0 ? liveKeys : this.keys;
    const key = pool[this.next % pool.length];
    this.next += 1;
    return key;
  }

  /** Marks a key as confirmed invalid by the provider (not a rate limit) —
   * excluded from `take()`'s rotation for the rest of this build. Logs
   * once per key, naming only its last 4 characters. What "confirmed
   * invalid" means is provider-specific (Groq: a real 401; Gemini: a real
   * 400 with `API_KEY_INVALID` — genuinely different conventions, see
   * llm.ts's isInvalidKeyError/isGeminiInvalidKeyError), so this class
   * stays provider-agnostic and the log message doesn't name a status code. */
  markDead(key: string): void {
    if (this.deadKeys.has(key)) return;
    this.deadKeys.add(key);
    const remaining = this.keys.length - this.deadKeys.size;
    console.warn(`[cairn] API key ending in "${key.slice(-4)}" is invalid (confirmed by the provider) — excluded from rotation for the rest of this build. ${remaining} of ${this.keys.length} configured key(s) remain.`);
  }

  /** How many distinct keys are configured. */
  get size(): number {
    return this.keys.length;
  }

  /** How many configured keys have NOT been marked dead. */
  get liveSize(): number {
    return this.keys.length - this.deadKeys.size;
  }
}

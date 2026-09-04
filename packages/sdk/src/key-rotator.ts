// Round-robins across a comma-separated list of API keys (e.g. `GROQ_API_KEYS`)
// so runtime verb calls spread across several free-tier rate limits instead
// of hammering a single key. Mirrors packages/indexer/src/key-rotator.ts —
// small enough that duplicating it beats adding a shared package for it.

export class KeyRotator {
  private keys: string[];
  private next = 0;

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

  take(): string {
    const key = this.keys[this.next % this.keys.length];
    this.next += 1;
    return key;
  }

  /** How many distinct keys are configured — callers use this to bound a
   * rate-limit retry loop (no point trying more times than there are
   * actual keys to fall back to). */
  get size(): number {
    return this.keys.length;
  }
}

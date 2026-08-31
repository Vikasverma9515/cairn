// A fixed-size worker pool, not Promise.all(items.map(...)) — for a large
// app (hundreds of pages), firing every LLM call at once would slam
// straight into provider rate limits; sequential (the original L3
// implementation) is correct but leaves real throughput on the table —
// GroqDescribeClient's KeyRotator already round-robins multiple API keys
// specifically for this, but a for-loop awaiting one call at a time never
// actually exercised more than one key at once. A bounded pool is the
// middle ground: real parallelism, still capped.

export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Retries a rate-limited (429) or transient-server-error (5xx) call with
 * backoff — found live and necessary, not theoretical: raising describeAll's
 * concurrency (see DEFAULT_DESCRIBE_CONCURRENCY) surfaced a real 429 from
 * Groq on a 40-page build within seconds ("Rate limit reached... tokens per
 * minute"), which without this would have thrown straight out of
 * mapWithConcurrency's Promise.all and aborted the *entire* build,
 * discarding every other page's already-completed work too. Honors the
 * provider's Retry-After header when present (both the Anthropic and Groq
 * SDKs expose one on a 429), falls back to exponential backoff otherwise.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxAttempts?: number; baseDelayMs?: number },
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 4;
  const baseDelayMs = opts?.baseDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxAttempts) throw err;
      const delayMs = retryAfterMs(err) ?? baseDelayMs * 2 ** (attempt - 1);
      console.error(`[cairn] retryable error (attempt ${attempt}/${maxAttempts}), waiting ${Math.round(delayMs)}ms:`, errorMessage(err));
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  return status === 429 || (typeof status === "number" && status >= 500);
}

function retryAfterMs(err: unknown): number | null {
  const headers = (err as { headers?: { get?: (name: string) => string | null } })?.headers;
  const raw = headers?.get?.("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

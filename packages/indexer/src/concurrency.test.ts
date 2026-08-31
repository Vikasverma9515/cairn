import { describe, expect, it } from "vitest";
import { mapWithConcurrency, withRetry } from "./concurrency";

function statusError(status: number): Error & { status: number } {
  return Object.assign(new Error(`http ${status}`), { status });
}

describe("mapWithConcurrency", () => {
  it("returns results in input order regardless of completion order", async () => {
    const items = [30, 10, 20];
    const result = await mapWithConcurrency(items, 3, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(result).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` at once", async () => {
    let inFlight = 0;
    let maxObserved = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (i) => {
      inFlight += 1;
      maxObserved = Math.max(maxObserved, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return i;
    });

    expect(maxObserved).toBeLessThanOrEqual(3);
  });

  it("processes every item exactly once", async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const seen: number[] = [];
    await mapWithConcurrency(items, 7, async (i) => {
      seen.push(i);
      return i;
    });
    expect(seen.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("handles an empty list without hanging", async () => {
    const result = await mapWithConcurrency([], 5, async (x) => x);
    expect(result).toEqual([]);
  });

  it("propagates a thrown error from the worker fn", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error("boom");
        return i;
      }),
    ).rejects.toThrow("boom");
  });
});

describe("withRetry", () => {
  it("returns the result on first success — no retry needed", async () => {
    const result = await withRetry(async () => "ok", { baseDelayMs: 1 });
    expect(result).toBe("ok");
  });

  it("retries a 429 and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw statusError(429);
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("retries a 503 the same way as a 429", async () => {
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) throw statusError(503);
        return "ok";
      },
      { baseDelayMs: 1 },
    );
    expect(attempts).toBe(2);
  });

  it("does not retry a non-retryable (e.g. 400) error — fails immediately", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw statusError(400);
        },
        { baseDelayMs: 1 },
      ),
    ).rejects.toThrow("http 400");
    expect(attempts).toBe(1);
  });

  it("gives up after maxAttempts and throws the last error", async () => {
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw statusError(429);
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("http 429");
    expect(attempts).toBe(3);
  });

  it("honors a Retry-After header instead of the default backoff", async () => {
    const start = Date.now();
    let attempts = 0;
    await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 2) {
          const err = statusError(429) as Error & { status: number; headers: { get: (n: string) => string | null } };
          err.headers = { get: (name: string) => (name === "retry-after" ? "0.05" : null) }; // 50ms — short, keeps the test fast
          throw err;
        }
        return "ok";
      },
      { baseDelayMs: 10_000 }, // if Retry-After weren't honored, this test would take 10s+
    );
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

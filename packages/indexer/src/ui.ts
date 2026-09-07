// Error classification for `cairn setup`/`cairn build`'s own retry
// flows — provider-agnostic, unrelated to how it's rendered. The actual
// terminal UI (spinners, prompts, colors) is @clack/prompts now (see
// clack.ts) — this file used to also hand-roll a Spinner class and ANSI
// color helpers for that, retired once every real call site moved to
// clack's own, more polished versions of the same things.

export type ErrorKind = "rate_limit" | "auth" | "network" | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  summary: string; // one line, human-readable, no stack trace
}

/** Turns a raw thrown error into a plain-English category + summary —
 * the thing `cairn setup` actually reasons about when deciding what to
 * offer next (switch provider vs. just retry vs. nothing to fix). */
export function classifyError(err: unknown): ClassifiedError {
  const status = (err as { status?: number } | undefined)?.status;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 429 || /rate.?limit/i.test(message)) {
    return { kind: "rate_limit", summary: "the provider is rate-limiting requests — this key has hit its per-minute quota" };
  }
  if (status === 401 || status === 403 || /invalid.*key|unauthorized|authentication/i.test(message)) {
    return { kind: "auth", summary: "that API key was rejected — check it's correct and active" };
  }
  if ((typeof status === "number" && status >= 500) || /ECONNRESET|ETIMEDOUT|network/i.test(message)) {
    return { kind: "network", summary: "the provider's servers had a problem — often transient" };
  }
  return { kind: "unknown", summary: message };
}

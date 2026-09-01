// A small terminal UI toolkit for `cairn setup` — zero new dependencies,
// plain ANSI codes (this is a handful of escape sequences, not a reason
// to pull in a whole chalk/ora dependency tree). Every piece degrades
// gracefully when stdout isn't a real TTY (CI logs, piped output): the
// spinner just prints its text once instead of animating, and colors
// still work fine (most CI systems render ANSI color codes correctly
// even without an interactive terminal).

const ESC = "\x1b[";
const color = (code: string, s: string) => `${ESC}${code}m${s}${ESC}0m`;

export const dim = (s: string) => color("2", s);
export const bold = (s: string) => color("1", s);
export const green = (s: string) => color("32", s);
export const yellow = (s: string) => color("33", s);
export const red = (s: string) => color("31", s);
export const cyan = (s: string) => color("36", s);

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class Spinner {
  private text: string;
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly animated: boolean;

  constructor(text: string) {
    this.text = text;
    this.animated = !!process.stdout.isTTY;
  }

  start(): void {
    if (!this.animated) {
      console.log(dim(this.text));
      return;
    }
    this.timer = setInterval(() => {
      process.stdout.write(`\r${ESC}K${cyan(FRAMES[(this.frame = (this.frame + 1) % FRAMES.length)])} ${this.text}`);
    }, 80);
  }

  /** Update the line in place without starting a new one. */
  update(text: string): void {
    this.text = text;
    if (!this.animated) console.log(dim(text));
  }

  /** Stop animating and print a final, non-spinning result line. */
  stop(finalLine: string): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.animated) process.stdout.write(`\r${ESC}K`);
    console.log(finalLine);
  }
}

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

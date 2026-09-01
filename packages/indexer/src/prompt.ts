// A tiny prompt helper for `cairn setup` — built on Node's own `readline`
// deliberately, not a new dependency, for something this small. Every
// prompt this module offers is skippable: an empty answer means "skip,"
// never a forced choice, matching setup's whole "ask, don't require"
// design.

import readline from "node:readline";

let sharedInterface: readline.Interface | null = null;

function rl(): readline.Interface {
  if (!sharedInterface) {
    sharedInterface = readline.createInterface({ input: process.stdin, output: process.stdout });
  }
  return sharedInterface;
}

export function closePrompts(): void {
  sharedInterface?.close();
  sharedInterface = null;
}

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl().question(question, (answer) => resolve(answer.trim())));
}

/** A yes/no prompt. Empty answer (just pressing enter) takes `fallback`. */
export async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  const suffix = fallback ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(question + suffix)).toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

/** A free-text prompt where an empty answer means "skip this." Returns null when skipped. */
export async function askOptional(question: string): Promise<string | null> {
  const answer = await ask(question);
  return answer.length > 0 ? answer : null;
}

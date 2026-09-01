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

export interface SelectOption {
  label: string;
  value: string;
}

/**
 * A numbered menu instead of free text — the actual fix for "I had to
 * type the exact provider name." Prints the choices, accepts a number,
 * and (for anyone who prefers typing) also accepts the label/value text
 * itself, case-insensitively. Empty answer takes `defaultIndex`.
 */
export async function selectFromList(question: string, options: SelectOption[], defaultIndex = 0): Promise<string> {
  console.log(question);
  options.forEach((o, i) => {
    const marker = i === defaultIndex ? " (default)" : "";
    console.log(`  ${i + 1}. ${o.label}${marker}`);
  });
  const answer = await ask(`Choose [1-${options.length}]: `);
  if (!answer) return options[defaultIndex].value;

  const asNumber = Number(answer);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= options.length) {
    return options[asNumber - 1].value;
  }
  const byText = options.find(
    (o) => o.value.toLowerCase() === answer.toLowerCase() || o.label.toLowerCase().includes(answer.toLowerCase()),
  );
  return byText ? byText.value : options[defaultIndex].value;
}

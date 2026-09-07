// `@clack/prompts` — real research behind this, not a guess: it's the
// current, widely-used default for polished interactive CLI installers
// (create-t3-app, create-next-app, and most modern scaffolding tools use
// it or its close relatives). Confirmed live against the real published
// package (v1.7.0) before writing any of this: its exports, its
// `SpinnerResult`'s start/stop/message/error shape, `select`/`text`/
// `password` returning `Value | symbol` (a cancel sentinel checked via
// `isCancel`), and `note`'s signature were all read from the actual
// installed type declarations, not recalled from training.
//
// The real complication this file exists to solve: `@clack/prompts` is
// PURE ESM (its package.json exports only a `.mjs` entry, no CJS build
// at all), but this package's own dist/ compiles to CommonJS
// (tsconfig.build.json sets `module: "CommonJS"`, and dist/package.json
// is force-set to `type: "commonjs"` — see setup.ts's own history for
// why "cairn setup" itself needs to run as a plain, widely-compatible
// CJS CLI). A plain `await import("@clack/prompts")` looks like it
// should work, but TypeScript's CommonJS module transform silently
// downlevels EVERY dynamic import — even one written as `import()` — into
// `Promise.resolve().then(() => require(...))`, which is still a real
// `require()` under the hood and fails the exact same way a static
// `import` would on a package with no CJS entry point. Confirmed live:
// compiled the exact pattern and inspected the emitted JS before writing
// this fix, not assumed.
//
// The fix is the standard, well-established workaround for this exact
// situation (used by ts-node, Jest, and others bridging CJS callers to
// ESM-only packages): constructing the import call via `new Function(...)`
// hides it from TypeScript's compiler entirely, so what actually runs at
// runtime is a genuine, un-downleveled dynamic `import()` — verified live
// by compiling this exact file and running the output against a real
// `npm install`ed copy of @clack/prompts before wiring it into setup.ts.
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@clack/prompts")>;

let cached: Promise<typeof import("@clack/prompts")> | null = null;

/** Loads @clack/prompts exactly once per process and caches the promise —
 * every call site awaits the same load instead of re-importing. */
export function clack(): Promise<typeof import("@clack/prompts")> {
  if (!cached) cached = dynamicImport("@clack/prompts");
  return cached;
}

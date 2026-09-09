import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // evals-dashboard is a Next.js app with no src/ dir (app/, lib/,
    // components/) — real, non-trivial logic lives in lib/ (trace-summary.ts,
    // data.ts's own scoring math), so it gets its own explicit include
    // rather than being silently untested forever for not matching the
    // packages/*/src/ convention every other package follows.
    include: ["packages/*/src/**/*.test.ts", "packages/evals-dashboard/lib/**/*.test.ts"],
    server: {
      deps: {
        // Workspace packages ship raw TS as their "main" entry (no build step
        // in this repo yet); force vitest to transform them like local source.
        inline: [/^@cairnvibe\//],
      },
    },
  },
});

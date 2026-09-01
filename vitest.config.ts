import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    server: {
      deps: {
        // Workspace packages ship raw TS as their "main" entry (no build step
        // in this repo yet); force vitest to transform them like local source.
        inline: [/^@cairnvibe\//],
      },
    },
  },
});

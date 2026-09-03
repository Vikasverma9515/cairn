/** @type {import('next').NextConfig} */
const nextConfig = {
  // @cairnvibe/evals ships raw TS as its "./store" etc. export conditions
  // (no build step needed for this dashboard) — same reasoning as
  // examples/demo-app's own transpilePackages comment: Next's own SWC pass
  // needs to run over that raw source directly.
  transpilePackages: ["@cairnvibe/evals"],
  // better-sqlite3 (a real dependency of @cairnvibe/evals's store.ts) ships
  // native bindings — keep webpack from trying to bundle it, same fix
  // already applied in examples/demo-app/next.config.js for the same
  // reason.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

module.exports = nextConfig;

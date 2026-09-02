/** @type {import('next').NextConfig} */
const nextConfig = {
  // Both packages ship raw TS as the browser-facing "default" export
  // condition (see @cairnvibe/core/package.json's conditional exports —
  // Node's own require()/import gets its compiled CJS dist/ via the
  // "node" condition, but a bundler like webpack falls through to raw
  // source) — transpilePackages tells Next to run its own SWC pass over
  // that raw source like local code. Needed for @cairnvibe/core specifically
  // because it's imported directly by client ("use client") code
  // (verb-executor.ts) — a compiled CJS dist file reaching the browser
  // bundle graph breaks Fast Refresh's HMR instrumentation
  // ("Cannot use 'import.meta' outside a module", found live before this
  // conditional-exports setup existed).
  transpilePackages: ["@cairnvibe/sdk", "@cairnvibe/core"],
  // better-sqlite3 ships native bindings — keep webpack from trying to bundle it.
  // `ws` (used by @cairnvibe/sdk/speak-server and /realtime-server for the
  // Deepgram streaming Speak/transcribe sockets) needs the same treatment:
  // webpack-bundling it through transpilePackages above silently breaks its
  // WebSocket connections (found live — every speak request timed out after
  // ~10s and failed with ECONNRESET, even though the exact same code ran
  // correctly outside Next's dev bundler). (Next 14:
  // experimental.serverComponentsExternalPackages; renamed to the top-level
  // serverExternalPackages in Next 15.)
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "ws"],
  },
};

module.exports = nextConfig;

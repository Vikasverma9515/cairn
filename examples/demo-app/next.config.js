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
  // Real, live-found root cause of realtime connections repeatedly dying
  // mid-conversation, traced from this session's own new connection-count
  // logging: lib/db.ts's SQLite file lives at data/cairn-demo.db, INSIDE
  // this project directory — every write the demo app makes to it (a
  // misses-store report, a session event, a board card move, literally any
  // mutating API route) touches that file and, via SQLite's own WAL mode,
  // its -wal/-shm/-journal siblings too. Next's dev-mode file watcher
  // covers the whole project directory by default with no exclusion for
  // this — every one of those writes looked exactly like a source-code
  // change, triggering a Fast Refresh (sometimes a full reload, matching
  // the "Fast Refresh had to perform a full reload" warnings seen live in
  // this session's own terminal output). A full reload tears down
  // everything, including a live realtime WebSocket connection — this is
  // the actual mechanism behind "it stops listening after a while" and
  // "every 'hello' gets a generic greeting" (each reconnect is a genuinely
  // fresh connection with no memory of what came before). Excluding the
  // data directory (and SQLite's own auxiliary files, wherever they land)
  // from the watcher is the fix — not a client-side workaround for a
  // dev-server-level problem.
  webpack: (config, { dev }) => {
    if (dev) {
      // A clean array of glob strings, not merged with whatever Next's own
      // default already was (its own internal shape isn't guaranteed to be
      // string-only — merging it in tripped webpack's own config schema
      // validator: "ignored[0] should be a non-empty string").
      config.watchOptions = {
        ...config.watchOptions,
        ignored: ["**/node_modules/**", "**/.next/**", "**/data/**", "**/*.db", "**/*.db-journal", "**/*.db-wal", "**/*.db-shm"],
      };
    }
    return config;
  },
};

module.exports = nextConfig;

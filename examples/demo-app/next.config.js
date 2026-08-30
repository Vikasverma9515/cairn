/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@cairn/sdk", "@cairn/core"],
  // better-sqlite3 ships native bindings — keep webpack from trying to bundle it.
  // (Next 14: experimental.serverComponentsExternalPackages; renamed to the
  // top-level serverExternalPackages in Next 15.)
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

module.exports = nextConfig;

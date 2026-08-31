#!/bin/bash
# Non-negotiable regression test (BUILD_PLAN.md §5): the L1 scan is a pure
# function of the source tree. Same code in must produce byte-identical
# output on every run — no timestamps, no unsorted keys, no directory-order
# leakage. This never calls the LLM, so it needs no API key and runs in CI
# on every push.
set -e

cd "$(dirname "$0")/.."

# Invoke the built CLI directly rather than via `npx cairn`: npm only
# creates the node_modules/.bin/cairn symlink from packages/indexer's
# `bin` field if dist/ already exists at `npm ci` time. In CI, indexer is
# built *after* `npm ci` (see ci.yml), so that symlink never gets created
# and `npx cairn` fails with "could not determine executable to run" —
# found live, not theoretical. node dist/cli.js sidesteps npm's bin-linking
# timing entirely.
node packages/indexer/dist/cli.js scan ./examples/demo-app > /tmp/cairn-determinism-a.json
node packages/indexer/dist/cli.js scan ./examples/demo-app > /tmp/cairn-determinism-b.json

if diff /tmp/cairn-determinism-a.json /tmp/cairn-determinism-b.json > /dev/null; then
  echo "DETERMINISTIC OK"
else
  echo "NON-DETERMINISTIC: two scans of the same source produced different output" >&2
  diff /tmp/cairn-determinism-a.json /tmp/cairn-determinism-b.json >&2 || true
  exit 1
fi

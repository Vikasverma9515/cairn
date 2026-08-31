# @cairn/graph (Python) — the structure graph engine

Language-agnostic codebase indexing: tree-sitter parses source files into
symbols/imports/call-edges, stored in a local, sharded, incrementally-synced
SQLite database. This is Month 1 of the [platform-operator
plan](../../ROADMAP.md) — the foundation everything else (the MCP action
layer, the multi-agent orchestrator) is built on top of.

Python, not TypeScript, deliberately — this is the backend for an agentic
system, and the multi-agent orchestration this graph feeds (Month 3) is
Python-native too (see the plan's grounding on LangGraph). The rest of
Cairn (the widget, the Next.js-specific L1/L2/L3 analyzer) stays
TypeScript; this is a new, separate service, not a replacement for
`packages/indexer` yet.

## Why tree-sitter, one PyPI package per language

`tree-sitter-language-pack` looked like the obvious choice (bundles ~100
languages in one package) but fetches grammar binaries from a GitHub
release manifest the *first time each language is used* — confirmed live
here as a `DownloadError`. That's disqualifying for an on-prem/air-gapped
product: the whole pitch is "your code never leaves your machine," and a
runtime fetch to GitHub the first time someone indexes a Python file
directly contradicts that. `tree-sitter-typescript` /
`tree-sitter-javascript` compile their grammar into the wheel at install
time — nothing is fetched at runtime, ever. One package per language is
more setup than a bundle, but it's the only version of "SOTA" that's
actually consistent with the deployment story.

## Setup

```bash
cd services/graph
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Testing

```bash
python -m pytest tests/ -v
```

19 tests, all real assertions against actual parsed output — not
"does it run without throwing." Includes the guarantees that matter at
scale: an unchanged file is never re-parsed, a deleted file's rows are
actually removed (SQLite's `ON DELETE CASCADE` is a no-op unless
`PRAGMA foreign_keys = ON` is set — found by a test failing, not by
reading the SQLite docs closely enough the first time), and one
unparseable file never crashes the run or hides the rest of the index.

## Using it

```bash
python -m cairn_graph.cli build <dir> --db .cairn-graph.db
python -m cairn_graph.cli query <term> --db .cairn-graph.db
python -m cairn_graph.cli stats --db .cairn-graph.db
```

Live-verified against this actual repo, not a synthetic fixture: `python
-m cairn_graph.cli build /path/to/cairn` indexes all 76 real TS/TSX/JS
files in ~0.2s on a first run (parallel across cores via
`ProcessPoolExecutor`, confirmed via CPU%), correctly finds real symbols
at their real locations (`findElement` → `element-ladder.ts:9`,
`resolveVerb` → `server.ts:108`), and a second run with nothing changed
skips all 76 files and finishes in ~0.02s — the incremental-sync lever
that's supposed to make a lakhs-of-files repo's *second* index fast
actually does, measured, not assumed.

## What's not built yet

- **Python-language extraction** — the module is structured to add a
  language by registering one more `LanguageSpec` in `languages.py` plus
  its extraction branch in `extract.py`; Python itself isn't wired up
  yet, JS/TS was the higher-value first target since it's what this repo
  and most realistic pilot targets are actually written in.
- **Vector index / hybrid retrieval** — this is the structure-graph third
  of the plan's three-index design; the embeddings layer (Qdrant, per the
  plan) is a separate, not-yet-started piece.
- **MCP server** exposing this graph to an agent — the graph is real and
  queryable via the CLI above, but nothing serves it over MCP yet.
- **Stress test against a large *external* open-source monorepo** — this
  repo (76 files) proves the pipeline is correct; it doesn't prove
  "lakhs of files" doesn't hit some wall this size can't reveal. Worth
  doing before calling Month 1 fully done, on a repo of the user's
  choosing.

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

50 tests, all real assertions against actual parsed output — not
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
python -m cairn_graph.cli dead --db .cairn-graph.db
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

## Dead code detection

`reachability.py` walks the graph from every exported symbol (plus a
small, explicit, growable list of known framework-invocation conventions
— currently just `customElements.define`, found live) and flags anything
never reached. Iterated against this repo's own `dead` output until every
remaining flag was a genuinely understood gap, not noise — three real
bugs found and fixed along the way, each with a regression test:

1. `new X()` wasn't captured as a call edge at all, so a class only ever
   *instantiated* (never called as a bare function) — and everything its
   methods call — read as entirely dead.
2. A class registered via `customElements.define()` and never explicitly
   `new`'d anywhere (the browser instantiates it) needed its own root
   category, plus its own methods needed to inherit reachability from the
   class itself — a lifecycle method like `connectedCallback` is never
   the target of any literal call in source.
3. A call made from an anonymous callback — the `describe()`/`it()`
   pattern every `*.test.ts` file here uses — has no named enclosing
   symbol to traverse from; without treating `caller IS NULL` calls as
   unconditionally-executed roots, every local test fixture class used
   only inside a `describe()` block read as dead.

Net effect on this repo's own `dead` output while fixing these, in
order: **234 → 47 → 29 → 15 → 0** false positives against the real
87-file monorepo (TS/TSX/JS + this service's own Python source). The
47→29 step also included excluding a checked-in minified bundle file
that was polluting results with meaningless single-letter symbol names
— see `_looks_generated` in `build.py`.

The last 15 were both the same underlying gap, confirmed identically in
Python too (running `dead` against `cairn_graph`'s own source flagged
`_parse_one`, only ever referenced as `pool.submit(_parse_one, path)` —
passed as a value, never called; not a language-specific bug):

- **Type-position references** — a type/interface used only in an
  annotation (`function f(): Status`, `const x: ConnectionDeps`).
- **Values passed by reference, not called** — `<CairnMark />` as JSX,
  `onClick={handleArchive}` as a prop, a function passed to `pool.submit`
  or `.map()`.

Fixed by adding a general, deliberately loose `Reference` capture
(`extract.py`) alongside the existing precise call/instantiation
tracking — any bare identifier used as a value or type, not just the
callee of an actual call. The one hard correctness requirement this
introduced: a declaration's *own* name node must never count as a
reference to itself, or every declared symbol would trivially "use
itself" and nothing would ever read as dead again — enforced by
excluding each declaration's own name-node position (tracked by
`(start_byte, end_byte)`, not by node type, since e.g. a `type_alias`'s
own name and a type it references are both the same `type_identifier`
node type). Guarded by a regression test
(`test_reference_tracking_does_not_make_everything_reachable`) that
proves a genuinely unused function still reads as dead, specifically to
catch this failure mode if it ever regresses.

At this point the pass has real, tested coverage for every reachability
path found dogfooding it against two real, differently-shaped codebases
(this TS/TSX/JS+Python monorepo, and the pass's own Python source) —
accurate enough to trust for suggestions. Still worth a human in the loop
before deleting anything on a codebase this hasn't been run against yet;
"zero false positives on two repos" isn't the same claim as "zero false
positives, period."

## Language support

TypeScript, TSX, JavaScript, and Python — one `LanguageSpec` in
`languages.py` plus a language-specific extraction branch in
`extract.py` per language (`_walk` for the JS/TS grammar family,
`_walk_python` separately: several node *type names* are shared between
the two grammars — `call`/`call_expression` aside, `import_statement`
means something structurally different in each — sharing one walker
would mean disambiguating every such node by language anyway, so each
grammar family gets its own walker instead). Python's "exported" is the
real Python convention, not a copy of JS's `export` keyword: a
module-level name not prefixed with `_` is public; dunder methods
(`__init__`, `__str__`, ...) are always treated as reachable regardless,
since the interpreter's own object protocol calls them, not any code in
the file being indexed — the same category as a Web Component's
`connectedCallback`. Python also needs no `new_expression` handling at
all: `Widget()` is Python's actual instantiation syntax, already the
same `call` node every plain function call produces.

## MCP server

`mcp_server.py` exposes the graph to an agent over MCP — the piece that
turns "a queryable SQLite file" into something a planner/orchestrator
agent can actually call mid-conversation, without shelling out to the CLI.

```bash
cairn-graph-mcp <root-dir> --db .cairn-graph.db --transport stdio
```

Five tools, each a thin wrapper over a plain, independently-testable
function (`search_symbols`, `get_symbol_usages`, `find_dead_code`,
`get_index_stats`, `reindex`) bound to one open connection by a
`build_server(db_path, root)` factory:

- **`search`** — find symbols by name substring.
- **`usages`** — every call site and reference for a name, so an agent can
  check "what happens if I change this" before touching it.
- **`dead_code`** — the same reachability pass as the CLI's `dead`
  command, paginated with a `truncated` flag.
- **`stats_tool`** — index size (files/symbols/imports/calls/failures).
- **`reindex_tool`** — re-scan after the agent (or the user) changes
  files, so the graph doesn't silently drift stale over a long session;
  only changed files are re-parsed.
- **`semantic`** — search by meaning instead of name (see "Semantic search"
  below).
- **`vectorize_tool`** — (re)build the semantic index after a `build` or
  `reindex_tool`.
- **`apply_edit_tool`** — the first action tool, gated by the permission
  layer below; everything else in this list is read-only.

**API-drift note, found live, not assumed**: this targets `mcp` 2.x, where
`FastMCP` was renamed to `MCPServer`. Importing the old `mcp.server.fastmcp`
path against the installed 2.1.1 package doesn't just fail — it raises a
`ModuleNotFoundError` with the migration built into the message, telling
you to import `MCPServer` from `mcp.server.mcpserver` instead. Tool
registration (`@server.tool()`) and listing (`await server.list_tools()`
returning `list[Tool]`) were both verified against the real installed
package via a live smoke test before being relied on in code or tests —
same "verify against the running package, not training data" discipline
that caught the `tree-sitter-language-pack` download issue and the
`FastMCP` rename itself.

## Semantic search

`vectors.py` adds the second index the plan calls for alongside the
structure graph: search by what code *does*, not what it's named.
`calculateInvoiceTotal` and a query like "sum up line item prices" are
unrelated by substring but adjacent by meaning — `query`/`search` can't
find that match; `semantic` can.

```bash
python -m cairn_graph.cli vectorize --db .cairn-graph.db --vectors .cairn-graph-vectors
python -m cairn_graph.cli semantic "sum up line item prices" --vectors .cairn-graph-vectors
```

Two design choices, both driven by the same on-prem/no-data-leakage
constraint that shaped the tree-sitter choice:

- **Embeddings run locally via `fastembed`** (ONNX runtime, no `torch` —
  a far lighter install than `sentence-transformers` for the same job).
  Model weights (`BAAI/bge-small-en-v1.5`, ~67MB) are fetched once from
  Hugging Face on first use and cached under `~/.cache/fastembed`; every
  embedding call after that runs fully offline. Verified live: a real
  `TextEmbedding` call downloads and embeds successfully in this
  environment, confirmed by dimension (384) and a working
  nearest-neighbor query, not assumed from the package's docs.
- **Storage is Qdrant in embedded mode** (`QdrantClient(path=...)`) — no
  server process, just an on-disk index next to the SQLite graph, the
  same "no infra to run" shape as the rest of this service. Verified live
  with a real collection create/upsert/query round-trip. A real Qdrant
  server (`QdrantClient(url=...)`) is a drop-in swap for a deployment that
  outgrows embedded mode; not needed at this product's realistic scale.

Each symbol's embedding text is its own source lines (read off disk at
index time, capped at 40 lines), not just its name — the embedding
captures what the code actually does. Both `build_vector_index` and
`search_semantic` take an injectable `embed_fn`, so the test suite (5
tests in `test_vectors.py`, plus 2 more exercising the MCP `semantic`
tool) runs against a deterministic hashing-trick fake embedder — real
nearest-neighbor-by-shared-vocabulary behavior, asserted exactly, with no
network call or model load in the hot path of `pytest`.

## Permission gate (Month 2, first slice)

`actions.py` is the start of the action layer the platform-operator plan
calls for — an agent that doesn't just read the graph but can act on the
codebase, with the exact behavior pillar 4 of the plan asked for: **auto
mode** (safe/reversible actions proceed, critical ones still stop) vs.
**review mode** (everything mutating stops and asks first).

Three risk tiers, one rule each:

- **SAFE** (read-only — `search`, `usages`, `dead_code`, `semantic`, …) —
  always proceeds, in either mode.
- **REVIEW** (mutating but scoped and reversible — right now, exactly one
  action: a single-file text replace) — proceeds in auto mode, stops and
  asks in review mode. This is the entire behavioral difference between
  the two modes.
- **CRITICAL** (destructive, or reaches outside the indexed root — nothing
  wired up to this tier yet) — always stops, in *either* mode. Mirrors
  this agent's own "Prohibited" / "Explicit permission required" action
  categories: some things don't get an auto-mode bypass, ever.

The one action live right now is `apply_edit` — a single-file text
replace, same semantics as this agent's own Edit tool: the text to
replace must match exactly once in the file, or the edit is refused
rather than guessing which occurrence was meant. Scoped to the indexed
root with a real path-escape check (`os.path.realpath` +
`os.path.commonpath`, not string-prefix matching) — verified live with a
`../` traversal attempt that gets rejected before touching disk, not just
asserted in a unit test.

Server default is **review mode** — a server doesn't silently start
willing to auto-apply edits; that's an explicit `--mode auto` opt-in.
`apply_edit_tool`'s gated response shape mirrors this agent's own
tool-permission flow: a `needs_approval` response carries a human-readable
`description`; the caller shows it to a person and calls again with
`approved=true` only after they say yes — the tool never decides that for
itself.

8 new tests (`test_actions.py`) plus 3 more in `test_mcp_server.py`
covering the MCP-bound gated flow (blocked in review mode, proceeds in
auto mode, proceeds in review mode once approved) — all verified against
a real file on disk, not mocked I/O.

## What's not built yet

- **More languages beyond TS/TSX/JS/Python** — Go, Java, Rust, etc. Same
  shape of work as adding Python was: one `LanguageSpec` plus a
  language-specific extraction branch (a new grammar family likely needs
  its own walker, same reasoning as `_walk_python`'s docstring).
- **Incremental vector sync** — `vectorize` is currently a full rebuild;
  the structure graph's incremental (content-hash, skip-unchanged) sync
  doesn't yet apply to the vector index. Fine at hundreds of files, worth
  revisiting before claiming it at "lakhs of files" scale.
- **Stress test against a large *external* open-source monorepo** — this
  repo (76 files) proves the pipeline is correct; it doesn't prove
  "lakhs of files" doesn't hit some wall this size can't reveal. Worth
  doing before calling Month 1 fully done, on a repo of the user's
  choosing.

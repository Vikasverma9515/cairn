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

TypeScript, TSX, JavaScript, Python, Go, Java, and Rust — one
`LanguageSpec` in `languages.py` plus a language-specific extraction
branch in `extract.py` per language (`_walk` for the JS/TS grammar
family, `_walk_python`, `_walk_go`, `_walk_java`, and `_walk_rust`
separately: several node *type names* are
shared across these grammars — `call`/`call_expression` aside,
`import_statement` means something structurally different in each —
sharing one walker would mean disambiguating every such node by language
anyway, so each grammar family gets its own walker instead). Python's
"exported" is the real Python convention, not a copy of JS's `export`
keyword: a module-level name not prefixed with `_` is public; dunder
methods (`__init__`, `__str__`, ...) are always treated as reachable
regardless, since the interpreter's own object protocol calls them, not
any code in the file being indexed — the same category as a Web
Component's `connectedCallback`. Python also needs no `new_expression`
handling at all: `Widget()` is Python's actual instantiation syntax,
already the same `call` node every plain function call produces.

**Go**, added the same way Python was: its own real convention for
"exported" (a name's first letter being uppercase — no keyword, verified
live against `tree-sitter-go` before writing the check), a `method`
kind whose `parent` is resolved from the receiver's type (`(w *Widget)
Render()` → parent `"Widget"`), and `call_expression`/selector-call
handling that covers constructor-style factory functions (`NewWidget()`)
for free, the same way Python's plain `call` node covers `Widget()` —
Go has no `new` keyword either. **Two real bugs found and fixed
dogfooding this, both live-verified against the actual grammar before
being trusted**: `pointer_type` (the node for a `*Widget`-shaped
receiver) turned out to have no field named `"type"` —
`child_by_field_name("type")` silently returns `None` rather than
erroring, so the first version fell through to the wrong node and a
pointer-receiver method's `parent` came out as the literal string
`"*Widget"` instead of `"Widget"`, caught by a test asserting a value
receiver and a pointer receiver on the same struct resolve to the same
parent. Fixed by taking the `type_identifier` child directly instead of
trusting a field name that doesn't exist. Dogfooded further against a
realistic synthetic Go web-service file (an interface, a struct
implementing it, pointer-receiver methods, `net/http` handler wiring,
grouped imports) — 12 symbols, 0 false positives on `dead`, correctly
flagging exactly the one genuinely unused function.

**Java**, same shape again: `exported` is a real `public` modifier check
(`modifiers` is a genuine child node of `class_declaration`/
`method_declaration`/`constructor_declaration` but — found live —
**not** a named field; `child_by_field_name("modifiers")` silently
returns `None`, so it has to be found by scanning children for the type
instead of asked for by name), interface methods are implicitly public
with no modifier at all, and constructors are captured as a `method`
symbol named after their own class (`Widget`'s constructor is a method
named `"Widget"`) — so `new Widget()` reaches both the class and its
constructor through the same name-based match, no separate synthesis
needed the way JS's `new_expression` needed one. A second live-verified
catch: a wildcard import (`import java.util.*;`) parses with the package
prefix (`java.util`) and the `*` as *separate sibling children*, not one
combined node — an early version would have silently bound a fake local
name `"util"` for a wildcard import had a live inspection of the actual
child list not caught it before the code was written, not after.

**A real bug in `reachability.py` itself, found dogfooding Java, not
Java-specific**: "a reachable class marks all its methods reachable"
used to fire for *every* reachable class, not just ones registered with
a framework — so an ordinary exported class with a genuinely unused
private helper method had that helper read as reachable purely because
the class itself was reachable, for every method on it, unconditionally.
That's the exact opposite of useful for the pattern — a private helper
nobody calls anymore — dead-code detection exists to catch, and every
existing test the broader rule was meant to cover (the
`customElements.define` case) turned out to only actually need the
narrower, framework-root-scoped version. Fixed by scoping that
propagation to `current.name in framework_root_names`; a dedicated
regression test (`test_by_parent_propagation_is_scoped_to_framework_roots_
not_every_reachable_class`) guards it directly in TypeScript, where the
bug was just as real, just never triggered by an existing test.

**Rust**, same shape once more: `exported` is a real `visibility_modifier`
child check (`pub`, same non-field-based scan as Java's modifiers, since
this is also a real but unnamed child node — checked live before writing
the code this time, not after). Methods live inside `impl Type { ... }`
blocks, which aren't symbols themselves — they just set the enclosing
name so every `function_item` in their body picks up the right `parent`,
the same trick Python's `class_definition` handling already uses; this
also means `impl Trait for Type { ... }` (implementing a trait) attaches
its methods to `Type`, not `Trait`, which is the name real call sites
actually use. Call-edge extraction handles all three real Rust call
shapes: a plain `inner()`, an associated-function call like
`Widget::new()` (the callee is `scoped_identifier`'s `name` field — always
the last path segment, verified live, so `Widget::new` correctly
resolves to `new`, not the full path), and a method call like
`w.render()` (`field_expression`'s `field` field). Imports
(`use std::{fmt, io};`, `use ... as alias;`, `use ...::*;`) each needed
their own real grammar node checked live — `scoped_use_list`,
`use_as_clause`, `use_wildcard` — before being handled, not assumed
to look like Go's or Java's. Dogfooded against a realistic synthetic
Rust service (a trait, two `impl` blocks including a trait impl,
associated functions, method dispatch, a `Display` impl using a macro)
— 14 symbols, 0 false positives on `dead`, correctly flagging the one
genuinely unused method.

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
- **`apply_edit_tool`** / **`create_file_tool`** — REVIEW-tier actions,
  gated by the permission layer below.
- **`delete_file_tool`** / **`run_command_tool`** — CRITICAL-tier actions,
  always gated regardless of mode.
- **`audit_log_tool`** — every gated decision so far, most recent first.
- **`remember_tool`** / **`recall_tool`** / **`record_turn_tool`** /
  **`recent_history_tool`** — per-customer memory (see "Memory" below).
  Everything else in this list is read-only.

**Threading note, found live**: the SDK runs every sync tool function on
a worker thread (`anyio.to_thread.run_sync`), not the thread that built
the server. `sqlite3` connections default to same-thread-only access, so
a real `await server.call_tool(...)` crashed the moment a tool actually
touched the database — invisible until then, because every earlier test
called the plain functions (`search_symbols(conn, ...)`) directly and
never exercised the thread hop. Fixed by opening every connection with
`check_same_thread=False` and serializing all tool bodies that touch a
shared connection behind one `threading.Lock` in `build_server`. Two new
regression tests call tools through the real compiled server via
`call_tool()` specifically to keep this fixed.

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
`search_semantic` take an injectable `embed_fn`, so the test suite runs
against a deterministic hashing-trick fake embedder — real
nearest-neighbor-by-shared-vocabulary behavior, asserted exactly, with no
network call or model load in the hot path of `pytest`.

**Incremental, like the structure graph is** — `vectorize` only
(re-)embeds files whose content hash changed since the last call (a new
`vector_sync` table in `store.py`, same shape as the graph's own
`existing_hashes()`). A changed file gets a fresh set of symbol ids on
reindex (`upsert_file` deletes and reinserts its rows), so re-vectorizing
also deletes that file's *old* Qdrant points first — via a payload
filter on `file`, not by tracking old ids — or they'd become permanently
orphaned garbage the collection never overwrites. A removed file's
points are deleted and its `vector_sync` row dropped. **Found live while
building this**: embedded Qdrant holds an exclusive file lock per
storage directory, so opening a second `QdrantClient` against the same
`vector_dir` while the first is still alive (an early version did this —
one client for the delete step, a second for `create_collection`)
crashes with `RuntimeError: Storage folder ... is already accessed by
another instance`. Fixed by using exactly one client for the whole call.
Dogfooded live against the real cairn monorepo (661 symbols): first
`vectorize` took 533.79s of real embedding work; a second `vectorize`
with nothing changed took **0.14s wall time, 0 symbols embedded** — the
scale lever pillar 8/9's "works even at lakhs of files" needs on the
vector index, not just the parse graph, measured, not assumed.

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
- **CRITICAL** (destructive, or can't be scoped/reversed the way a single
  file edit can) — always stops, in *either* mode, no auto-mode bypass.
  Mirrors this agent's own "Prohibited" / "Explicit permission required"
  action categories.

Two actions live right now:

- **`apply_edit`** (REVIEW) — a single-file text replace, same semantics
  as this agent's own Edit tool: the text to replace must match exactly
  once in the file, or the edit is refused rather than guessing which
  occurrence was meant. Scoped to the indexed root with a real
  path-escape check (`os.path.realpath` + `os.path.commonpath`, not
  string-prefix matching) — verified live with a `../` traversal attempt
  that gets rejected before touching disk.
- **`run_command`** (CRITICAL) — runs an argv-form command (`shell=False`,
  no string interpolation) with `cwd` pinned to the indexed root, output
  capped at 10k chars, a real timeout (`subprocess.TimeoutExpired`
  caught and reported as `timed_out: true`, not left to hang). Always
  needs approval — there's no scoping check that could make "run
  whatever this says" safe enough to auto-mode, so `decide()` doesn't
  even look at the mode for this tier.

Server default is **review mode** — a server doesn't silently start
willing to auto-apply edits; that's an explicit `--mode auto` opt-in
(and doesn't affect `run_command` either way). Both gated tools share one
response shape, mirroring this agent's own tool-permission flow: a
`needs_approval` response carries a human-readable `description`; the
caller shows it to a person and calls again with `approved=true` only
after they say yes — the tool never decides that for itself.

Two more actions round out basic file CRUD:

- **`create_file`** (REVIEW) — refuses to overwrite an existing file
  (that's what `apply_edit` is for); makes intermediate directories.
- **`delete_file`** (CRITICAL) — this service has no way to know whether
  the indexed root is under version control, so it can't assume
  "reversible via git" the way a human operator might. Same category as
  this agent's own "permanently deleting data" rule: no auto-mode bypass,
  ever.

Every gated decision — whether it stopped for approval or actually ran —
is written to a SQLite `action_log` table (`store.py`), queryable via the
MCP `audit_log_tool` or `list_action_log()`. Not just "what did the agent
change" but "what did it *try* to change, and did a human have to
approve it" — the record a company evaluating this needs to trust it,
and the seed of Month 5's usage analytics.

24 new tests since the previous entry (`test_actions.py`,
`test_mcp_server.py`, and a new `test_store_action_log.py`) covering
every gated flow end to end (blocked in review mode, proceeds in auto
mode, proceeds once approved, CRITICAL blocked even in auto mode, audit
log records both blocked and applied outcomes) — all against real files,
real subprocesses, and a real SQLite db, not mocked I/O. 93 tests total.

## Multi-agent orchestration (Month 3, first slice)

`orchestrator.py` is pillar 2 of the plan — "best multi-agent systems
coordination" — built on a real `langgraph.graph.StateGraph`
(`langgraph` 1.2.11, API verified live: `StateGraph`/`add_node`/
`add_conditional_edges`/`compile`/`invoke` smoke-tested against the
installed package before writing this module, same discipline that
caught the `FastMCP` rename).

The actual design bet: the coordination failure mode that matters for
this product isn't "the model wasn't smart enough to route correctly" —
it's *scope*. One agent holding every tool eventually runs
`run_command_tool` on a request that was really just "where is X
defined?" So this module's job is routing **and** tool-scoping together:
a `planner_node` picks one of three specialists (`read`, `edit`, `exec`),
and each specialist hands back only the MCP tool names its role owns —
a `read` request never has `delete_file_tool` in its available toolset
at all, not merely an instruction not to call it.

```bash
python -m cairn_graph.cli route "delete the old scratch.ts file"
# specialist: exec
# scoped tools: delete_file_tool, run_command_tool
```

The routing decision is behind an injectable `Planner`
(`(request, specialists) -> name`) so a real LLM call can replace it
later (pillar 5 — configurable providers) without retesting the graph
wiring. `keyword_planner` is the zero-dependency default and is
deliberately asymmetric: an ambiguous request always falls back to
`read`, never to `exec` — routing a `read` request to the wrong
read-only specialist just costs a round-trip; routing an innocuous
request toward the CRITICAL-tier specialist is the actual failure mode
worth avoiding before the permission gate even gets a look.

11 tests (`test_orchestrator.py`), including a custom-planner injection
test and a duplicate-specialist-name rejection test. Dogfooded with three
real requests against the actual tool names this service exposes: a
"where is X" question, a "replace this string" edit, and a "delete this
file and run npm build" request — each correctly scoped to exactly the
right specialist's tools, nothing more.

## Memory (Month 4, first slice)

`memory.py` is pillar 6 — "self-learning for individual customers, with
memory." Same shape as the rest of this service: local SQLite, its own
db file (`.cairn-graph-memory.db` by default), nothing that leaves the
customer's machine.

Two kinds, kept deliberately separate:

- **Facts** (`remember`/`recall`/`forget`) — durable, keyed preferences
  ("permission mode is auto", "primary framework is Next.js").
  `remember()` is an upsert on `(customer_id, key)`, not an append-only
  log — a customer has one current value per key, not a history of every
  value it's ever held.
- **Conversation turns** (`record_turn`/`recent_history`) — an
  append-only per-customer history, kept separate from facts so session
  continuity doesn't require re-summarizing a long conversation just to
  answer "what's this customer's permission-mode preference."

Everything is scoped by `customer_id` — there is no "get everyone's
memory" path, the same multi-tenant discipline as the path-escape check
in `actions.py`. 9 tests (`test_memory.py`), plus 2 more in
`test_mcp_server.py` that round-trip `remember_tool`/`recall_tool`/
`record_turn_tool`/`recent_history_tool` through the real compiled
server (the same real-`call_tool()` pattern that caught the threading
bug above). Dogfooded live end to end: stored a fact and two turns
through the real threaded server, read them both back correctly.

## Provider abstraction (Month 4, second slice)

`providers.py` is pillar 5 — "publish this as a package and everyone can
configure the LLM models, voice models... customize according to their
needs." Three `Protocol`s (`LLMProvider`, `STTProvider`, `TTSProvider` —
structural typing, no base class required) plus a name-keyed `Registry`
per kind, selected via `load_provider(registry, env_var, default,
provider_name=None)`: explicit name wins, then the env var, then a safe
local default — never a silent surprise about which provider is live.

**Update: two real hosted providers are wired in.** Credentials for Groq
and Deepgram became available in this environment
(`examples/demo-app/.env`); `GroqLLMProvider` and `DeepgramSTTProvider`
were built against the real installed SDKs (`groq` 1.7.0, `deepgram-sdk`
7.8.0) and verified with real live calls before being trusted, same
discipline as everything else here:

- **Groq** — `client.chat.completions.create()` takes
  `max_completion_tokens`, not `max_tokens` (confirmed by reading the
  installed SDK's actual signature, not docs). The account's real
  available models were fetched live via `client.models.list()`, not
  guessed. First live test picked a reasoning-capable model
  (`openai/gpt-oss-20b`) and got back an *empty* reply — it spent its
  entire small token budget on invisible reasoning tokens, a real
  property of that model class. `GroqLLMProvider` defaults to
  `qwen/qwen3.8-27b` instead — a plain fast reply, 0.429s round-trip
  measured live, no reasoning overhead — for a low-latency "talking to a
  friend" default (pillar 3).
- **Deepgram** — the real call is
  `client.listen.v1.media.transcribe_file(request=audio_bytes,
  model=...)`, response at
  `.results.channels[0].alternatives[0].transcript`. Verified against
  real synthesized speech (macOS `say` + `afconvert` → WAV), not silence
  — a real transcript came back, not just a non-error response.
- **End-to-end proof, not just unit tests**: loaded the real Groq
  provider through `load_provider()`, fed it into
  `orchestrator.llm_planner()`, and routed a real request — "delete the
  old scratch.ts file" — through `route_request()`. It correctly reasoned
  its way to the `exec` specialist (`delete_file_tool`,
  `run_command_tool`) — genuine LLM judgment, not the keyword_planner's
  string matching. The real Deepgram provider transcribed real audio
  through the same `providers.py` code path used above.

Cartesia/ElevenLabs (TTS) remain unwired — no credentials for those were
available in this environment. Wiring one in is implementing `TTSProvider`
against that vendor's verified SDK; the registry and everything that
calls through it doesn't change. API keys are read once at construction
from `GROQ_API_KEY`/`DEEPGRAM_API_KEY` (or passed explicitly) and never
touched again — no key handling inside `complete()`/`transcribe()`, no
key ever logged, and the automated test suite (below) never makes a real
network call: constructing a client with a dummy string is safe and
free, since Groq/Deepgram's SDKs don't validate a key until a real
request is made.

Each Protocol also still ships one real, local, zero-network default:
`EchoLLMProvider` (echoes the prompt — a stand-in, not a real model, but
real enough to prove a pipeline end to end for free) and
`UnconfiguredSTTProvider`/`UnconfiguredTTSProvider` (raise a clear
`NotImplementedError` naming the env var to set — honest about a real
capability gap instead of silently returning fake empty audio/text).

The concrete integration point: `orchestrator.llm_planner(provider)`
wraps any `LLMProvider` into a routing `Planner`, replacing
`keyword_planner` without touching `build_orchestrator` or
`route_request`. Matches specialist names in the reply by word boundary
(`\bname\b`), not bare substring — needed because even `EchoLLMProvider`
trivially contains every candidate name in what it echoes back (they're
listed in the routing prompt itself), so a naive substring check could
match the wrong one for a request whose earlier options happen to share
a prefix.

22 tests (`test_providers.py`, including the Groq/Deepgram SDK-plumbing
tests — construction, missing-key handling, Protocol conformance, no
network call) plus 5 more in `test_orchestrator.py`. Dogfooded live twice:
once against the local `echo` provider, once end-to-end against the real
Groq and Deepgram providers as described above.

## Analytics (Month 5, first slice)

`analytics.py` is pillar 7 — "helps the company analyze the customer,
write the analytics, makes a dashboard to help company know their
product more." Deliberately the data layer only, not a rendered
dashboard (a real dashboard UI is a separate frontend concern) — real
SQL aggregations over data this service already collects (`action_log`
from `store.py`, `conversation_turns` from `memory.py`), returned as
plain dicts.

- **`action_summary`** — counts by outcome and by risk tier, optionally
  windowed by `since_days`. The two numbers a company evaluating this
  wants first: how much did the agent do, how much needed a human.
- **`top_tools`** — which tools actually get used, ranked by call count.
- **`daily_activity`** — one row per day with activity, a real time
  series (no zero-padding — a dashboard decides how to fill gaps).
- **`approval_rate`** — fraction of gated decisions that actually
  proceeded vs. stopped for approval. Returns `None`, not `0.0`, when
  there's no data yet — a real "unknown" instead of a misleading zero.
- **`customer_overview`** — the roster a company-facing dashboard starts
  from: every customer with either an action or a conversation turn,
  combining `store.py`'s action_log and `memory.py`'s conversation_turns
  (two separate db connections, since a real deployment might not point
  both at the same file).

Every function is scoped by an optional `customer_id` — omit for a
company-wide view, pass one for a single customer's usage, same
multi-tenant shape as `memory.py`. Wired into the MCP server as
`analytics_tool` and `customer_overview_tool`.

9 tests (`test_analytics.py`) plus 2 more in `test_mcp_server.py`
exercising both tools through the real compiled server. Dogfooded live:
an approved edit, a blocked delete, and a recorded conversation turn
through the real server — `analytics_tool` correctly reported 2 actions
(1 applied, 1 needs_approval), a 0.5 approval rate, and per-tool counts;
`customer_overview_tool` correctly listed the customer.

## Packaging (Month 5, second slice)

Pillar 9: "everything should install in their system... good for their
data, they can connect their own db... or use local repo only." One
`Dockerfile` builds the whole engine — indexer, MCP server, semantic
search, orchestrator, memory, analytics — into a single image:

```bash
docker build -t cairn-graph .
docker run --rm -it \
  -v /path/to/customer/repo:/workspace \
  -v cairn-data:/data \
  cairn-graph
```

Two choices worth calling out:

- **The embedding model is baked into the image at build time**
  (`RUN python -c "from fastembed import TextEmbedding; ..."`), not
  fetched on first `vectorize` call. The one network request this whole
  service ever needs happens once, at image-build time — a fresh
  container on an air-gapped customer machine never has to reach the
  internet to index their code.
- **The customer's code is mounted, never copied in.** `/workspace` (the
  repo) and `/data` (this service's own state — graph db, vector index,
  per-customer memory) are both volumes; nothing about a customer's
  codebase ever becomes part of the image itself.

Build-verified live in this environment, not just written and assumed
correct: a real `docker build` (36.7s for the pip install layer + 23.2s
to bake in the embedding model), then a real `docker run` against a
mounted two-symbol test file — `cairn_graph.cli build` indexed it,
`stats` reported the right counts, and `dead` correctly flagged the one
genuinely unused function. `cairn-graph-mcp --help` confirmed the default
entrypoint launches.

## Hardening (Month 6, first slice)

`cairn-graph doctor` checks that an install actually works before a
customer (or a CI job, or a support engineer three months from now)
finds out the hard way that one piece silently isn't wired up right:
tree-sitter parsers load, the SQLite store opens with WAL + foreign keys
active, the MCP SDK is importable and constructible, embedded Qdrant
opens a local collection, and the LangGraph orchestrator compiles and
routes a real request correctly. The embedding-model check is a warning,
never a hard failure, and never triggers the download itself — it
reports whether the model is *already* cached (via
`huggingface_hub.scan_cache_dir()`), so `doctor` stays fast and safe to
run repeatedly, including on a machine that hasn't run `vectorize` yet.

```bash
python -m cairn_graph.cli doctor
```

Every check is a plain function returning a `CheckResult`, so `run_checks`
is testable by injecting broken check functions directly rather than
needing an actually-broken environment to prove the aggregation and
failure-reporting logic works.

**Caught immediately, dogfooding this exact feature**: the first version
of `check_tree_sitter_parsers` called `parser_for("typescript")` — a bare
string — when `parser_for` actually takes a `LanguageSpec` object.
Running `doctor` for real crashed with `AttributeError: 'str' object has
no attribute 'id'` on the very first run. Fixed by routing the check
through `language_for_path()` first, the same extension → `LanguageSpec`
→ `Parser` path a real `build()` call takes — a better check besides
being the fix, since it now exercises the real code path instead of a
hand-built shortcut.

Also added a `services/graph` job to the repo's existing
`.github/workflows/ci.yml` (previously Node/TS-only) — its own job, not a
step bolted onto the existing one, since the two share no dependencies
and a failure in one shouldn't block or be attributed to the other.

7 new tests (`test_doctor.py`, including two that inject a broken/
exploding check function to prove the runner's failure handling — not
just that the happy path prints something). 154 tests total, all passing.

## What's not built yet

- **More languages beyond TS/TSX/JS/Python/Go/Java/Rust** — C#, Ruby,
  PHP, etc. Same shape of work as adding Rust was: one `LanguageSpec`
  plus a language-specific extraction branch (a new grammar family
  likely needs its own walker, same reasoning as `_walk_python`'s
  docstring).
- **Real hosted TTS/voice providers** — `providers.py` has real
  `GroqLLMProvider`/`DeepgramSTTProvider` now; Cartesia/ElevenLabs remain
  unwired, no credentials for those were available in this environment
  (see that module's docstring for why this wasn't guessed at instead).
- **A rendered analytics dashboard** — `analytics.py` is the data layer;
  an actual UI on top of it is a separate frontend concern.
- **Stress test against a large *external* open-source monorepo** — this
  repo (76 files) proves the pipeline is correct; it doesn't prove
  "lakhs of files" doesn't hit some wall this size can't reveal. Worth
  doing before calling Month 1 fully done, on a repo of the user's
  choosing.

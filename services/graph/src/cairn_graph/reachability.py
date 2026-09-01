"""Dead-code detection as a graph-reachability query over the structure
graph, not a separate whole-program pass.

Same idea Cairn's existing L2 pass already does for one Next.js app
(walk from real entry points, mark everything unreached) and the same
idea Meta's SCARF uses to auto-delete dead code at real scale — see the
plan. The only real design decision is what counts as an entry point in
a codebase with no single framework convention to lean on the way
Next.js's `app/`/`pages/` gives L2 for free: every *exported* symbol is
treated as a root, since without a specific app's routing convention
there's no cheaper way to know what's "used from outside this file" —
this is the conservative direction to be wrong in (a merely-unused
export reads as "reachable, keep it" rather than risking a real public
API reading as dead).

Reachability itself is the same name-based heuristic extract.py's call
edges already are: symbol A is reachable if some already-reachable
symbol calls (or merely *references* — see extract.py's Reference) a
name matching A, or imports A by name from A's file. Calls and
references are unioned into one "uses" signal here even though
extract.py keeps them as separate record types — that distinction (call
vs. bare reference) doesn't matter for "is this reachable at all", only
for anything wanting to know *how* a name was used.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass


@dataclass(frozen=True)
class SymbolRef:
    id: int
    file_id: int
    file_path: str
    kind: str
    name: str
    exported: bool
    parent: str | None


@dataclass(frozen=True)
class ReachabilityResult:
    reachable_count: int
    dead: list[SymbolRef]


def compute_dead_symbols(conn: sqlite3.Connection) -> ReachabilityResult:
    symbols = _load_symbols(conn)
    by_name: dict[str, list[SymbolRef]] = {}
    by_parent: dict[str, list[SymbolRef]] = {}
    for sym in symbols:
        by_name.setdefault(sym.name, []).append(sym)
        if sym.parent is not None:
            by_parent.setdefault(sym.parent, []).append(sym)

    uses_by_context = _load_uses_by_context(conn)  # calls + references, unioned — see module docstring
    imported_names = _load_imported_names(conn)
    framework_root_names = _load_framework_root_names(conn)
    top_level_uses = _load_top_level_uses(conn)

    reachable_ids: set[int] = set()
    # A `NULL` caller/referrer means the use happens outside any named
    # function — module top-level side-effect code, or (very commonly in
    # test files) inside an anonymous callback passed straight to
    # describe()/it()/etc. Either way it runs unconditionally whenever the
    # file loads, so what it uses is reachable regardless of whether
    # anything traceable "calls" the enclosing scope — found live:
    # dogfooding against this repo's own *.test.ts files, every locally-
    # defined test helper class/fixture function used only inside a
    # describe() block read as dead without this, since the callback
    # wrapping it has no name to traverse from.
    #
    # `s.name in imported_names` used to be a check done *inside* the BFS,
    # gated on the symbol whose name matched already being reachable —
    # which meant it could never actually be the reason anything became
    # reachable (a symbol has to be reachable before that branch can even
    # run), while still costing a full scan of every import in the
    # codebase on every single reachable symbol popped from the queue.
    # Found live stress-testing against a 175k-symbol real codebase: that
    # scan alone was the dominant cost behind a 23.5-minute run. Moving it
    # here is both the performance fix and the correctness fix — "a
    # symbol imported by name is reachable regardless of whether the
    # importing file is itself called" is a fact about the symbol from
    # the start, not something contingent on BFS order.
    roots = [s for s in symbols if s.exported or s.name in framework_root_names or s.name in top_level_uses or s.name in imported_names]
    queue: list[SymbolRef] = roots
    for s in queue:
        reachable_ids.add(s.id)

    # Tracks which *names* have already had their uses_by_context edges
    # expanded — not which symbol ids have been popped. Multiple distinct
    # symbols legitimately share a name in a codebase this size (hundreds
    # of unrelated methods called `get`/`dispose`/`handle`), and
    # uses_by_context is itself keyed by name, so re-running the same
    # name's expansion once per symbol sharing it was pure redundant work:
    # the set of names it discovers is identical every time. This turns
    # that from O(symbols sharing a name) back down to O(distinct names).
    processed_names: set[str] = set()

    while queue:
        current = queue.pop()

        # A class *registered with a framework* exposes its own methods
        # regardless of whether any call edge inside this codebase invokes
        # them directly — true by construction there: a lifecycle method
        # like connectedCallback is only ever invoked by the runtime,
        # never by a literal call_expression anywhere in source.
        #
        # Deliberately narrow to framework_root_names, not "every reachable
        # class" — found live, dogfooding Java: an ordinary exported class
        # with a genuinely unused private helper method (ordinary OOP, no
        # runtime magic involved) had that helper read as reachable purely
        # because the class itself was reachable, for every method on it,
        # unconditionally. That's the opposite of useful for exactly the
        # pattern — a private helper nobody calls anymore — this feature
        # exists to catch. Every existing test this broader rule was meant
        # to cover (the customElements.define case) only actually needs
        # the framework-root-scoped version; a plain "new Widget(); then
        # this.wire()" chain is already reachable through ordinary
        # name-based call edges, no propagation needed.
        if current.kind == "class" and current.name in framework_root_names:
            for method in by_parent.get(current.name, ()):
                if method.id not in reachable_ids:
                    reachable_ids.add(method.id)
                    queue.append(method)

        if current.name in processed_names:
            continue
        processed_names.add(current.name)

        # Follow calls/references from this symbol's name to any symbol
        # with a matching name (heuristic, not type-resolved — see
        # extract.py).
        for used_name in uses_by_context.get(current.name, ()):
            for candidate in by_name.get(used_name, ()):
                if candidate.id not in reachable_ids:
                    reachable_ids.add(candidate.id)
                    queue.append(candidate)

    dead = [s for s in symbols if s.id not in reachable_ids and not s.exported]
    return ReachabilityResult(reachable_count=len(reachable_ids), dead=dead)


def _load_symbols(conn: sqlite3.Connection) -> list[SymbolRef]:
    rows = conn.execute(
        "SELECT s.id, s.file_id, f.path, s.kind, s.name, s.exported, s.parent FROM symbols s JOIN files f ON f.id = s.file_id"
    ).fetchall()
    return [SymbolRef(id=r[0], file_id=r[1], file_path=r[2], kind=r[3], name=r[4], exported=bool(r[5]), parent=r[6]) for r in rows]


def _load_uses_by_context(conn: sqlite3.Connection) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for caller, callee in conn.execute("SELECT caller, callee FROM calls WHERE caller IS NOT NULL").fetchall():
        out.setdefault(caller, set()).add(callee)
    for referrer, name in conn.execute("SELECT referrer, name FROM references_ WHERE referrer IS NOT NULL").fetchall():
        out.setdefault(referrer, set()).add(name)
    return out


def _load_top_level_uses(conn: sqlite3.Connection) -> set[str]:
    names = {r[0] for r in conn.execute("SELECT DISTINCT callee FROM calls WHERE caller IS NULL").fetchall()}
    names |= {r[0] for r in conn.execute("SELECT DISTINCT name FROM references_ WHERE referrer IS NULL").fetchall()}
    return names


def _load_framework_root_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT DISTINCT name FROM framework_roots").fetchall()
    return {r[0] for r in rows}


def _load_imported_names(conn: sqlite3.Connection) -> set[str]:
    """Every distinct name imported anywhere in the codebase, flattened
    out of the JSON-encoded `names` column. Which *file* did the
    importing was never actually used by any caller of this — a symbol
    imported by name is reachable regardless of which file imported it,
    so a flat set of names is both simpler and, unlike the old flat
    (file_id, name) list this replaced, no longer the thing that made
    compute_dead_symbols scan every import in the codebase once per
    reachable symbol."""
    out: set[str] = set()
    for (names_json,) in conn.execute("SELECT names FROM imports").fetchall():
        out.update(json.loads(names_json))
    return out

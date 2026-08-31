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
symbol calls a name matching A, or imports A by name from A's file.
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

    calls_by_caller = _load_calls_by_caller(conn)
    files_importing_name = _load_import_usages(conn)
    framework_root_names = _load_framework_root_names(conn)
    top_level_callees = _load_top_level_callees(conn)

    reachable_ids: set[int] = set()
    # `caller IS NULL` means the call happens outside any named function —
    # module top-level side-effect code, or (very commonly in test files)
    # inside an anonymous callback passed straight to describe()/it()/etc.
    # Either way it runs unconditionally whenever the file loads, so its
    # callee is reachable regardless of whether anything traceable "calls"
    # the enclosing scope — found live: dogfooding against this repo's own
    # *.test.ts files, every locally-defined test helper class/fixture
    # function used only inside a describe() block read as dead without
    # this, since the callback wrapping it has no name to traverse from.
    roots = [s for s in symbols if s.exported or s.name in framework_root_names or s.name in top_level_callees]
    queue: list[SymbolRef] = roots
    for s in queue:
        reachable_ids.add(s.id)

    while queue:
        current = queue.pop()

        # A reachable class exposes its own methods regardless of whether
        # any call edge inside this codebase invokes them directly — true
        # by construction for a class instantiated by a framework (a
        # lifecycle method like connectedCallback is only ever invoked by
        # the runtime, never by a literal call_expression anywhere in
        # source) and the conservative direction to be wrong in generally:
        # a class that's genuinely in use very rarely has a truly-dead
        # method sitting on it.
        if current.kind == "class":
            for method in by_parent.get(current.name, ()):
                if method.id not in reachable_ids:
                    reachable_ids.add(method.id)
                    queue.append(method)

        # Follow call edges from this symbol's name to any symbol with a
        # matching name (heuristic, not type-resolved — see extract.py).
        for callee_name in calls_by_caller.get(current.name, ()):
            for candidate in by_name.get(callee_name, ()):
                if candidate.id not in reachable_ids:
                    reachable_ids.add(candidate.id)
                    queue.append(candidate)

        # A symbol imported by name into some file is reachable regardless
        # of whether that importing file's own top-level code is itself
        # "called" by anything — importing is its own use.
        for importer_file_id, imported_name in files_importing_name:
            if imported_name != current.name:
                continue
            for candidate in by_name.get(imported_name, ()):
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


def _load_calls_by_caller(conn: sqlite3.Connection) -> dict[str, set[str]]:
    rows = conn.execute("SELECT caller, callee FROM calls WHERE caller IS NOT NULL").fetchall()
    out: dict[str, set[str]] = {}
    for caller, callee in rows:
        out.setdefault(caller, set()).add(callee)
    return out


def _load_top_level_callees(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT DISTINCT callee FROM calls WHERE caller IS NULL").fetchall()
    return {r[0] for r in rows}


def _load_framework_root_names(conn: sqlite3.Connection) -> set[str]:
    rows = conn.execute("SELECT DISTINCT name FROM framework_roots").fetchall()
    return {r[0] for r in rows}


def _load_import_usages(conn: sqlite3.Connection) -> list[tuple[int, str]]:
    """(importing_file_id, imported_name) pairs, flattened out of the
    JSON-encoded `names` column — kept as a flat list rather than a dict
    since one name can legitimately be imported by many files."""
    rows = conn.execute("SELECT file_id, names FROM imports").fetchall()
    out: list[tuple[int, str]] = []
    for file_id, names_json in rows:
        for name in json.loads(names_json):
            out.append((file_id, name))
    return out

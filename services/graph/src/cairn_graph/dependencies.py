"""File-level dependency graph — the third of the plan's three-index
design (parse graph + vector index + relationship/dependency index),
computed live from the existing `imports`/`files` tables rather than a
separately-synced store — the same choice `reachability.py` already
made: recomputing from current graph state is simpler than keeping a
second index in sync with it.

Distinct from `mcp_server.get_symbol_usages` (symbol-level, name-based,
has no notion of which *file* a name came from): this answers "what does
this file depend on" and "what would break if I change this file" at
file granularity, by actually resolving each import's source string to a
real indexed file path.

Scope cut, stated plainly rather than silently guessed around: only a
*relative* import resolves to an internal file edge — TS/JS `./foo`-
style paths and Python `.foo`-style relative imports, the two import
styles this graph already flags `is_relative` for. A package import
(`react`, `std::collections::HashMap`, `java.util.List`, an absolute Go
module path) is an *external* dependency — not an edge between two files
in this repo — and is reported separately, not dropped or guessed at.
Go, Java, and Rust don't have a relative-import concept the same way
(`extract.py`'s Go/Java/Rust import handling always records
`is_relative=False`), so this module's internal-edge resolution is real
today for TS/JS/Python and will need per-language resolution rules added
alongside any future language's own import conventions, same shape as
everything else in this service.
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass

_JS_EXTENSIONS = (".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs")
_PY_EXTENSIONS = (".py", ".pyi")


def resolve_import_path(importer_path: str, source: str, is_relative: bool, indexed_paths: set[str]) -> str | None:
    """Resolves one import's `source` string to a real indexed file path,
    or None if it's external (a package import) or points somewhere not
    in this graph (e.g. a file excluded from indexing). `indexed_paths`
    is the full set of paths currently in the graph — resolution never
    trusts a candidate path that isn't actually there."""
    if not is_relative:
        return None

    base_dir = os.path.dirname(importer_path)
    if source.startswith("."):
        # Python-style: leading dots count package levels up from the
        # importer's own directory (".foo" = sibling module, "..foo" =
        # parent package), the rest is a dotted module path. TS/JS-style
        # ("./foo", "../foo") also starts with one or more dots but uses
        # real path separators after the first segment, not more dots —
        # disambiguate by whether a "/" appears anywhere in the string.
        if "/" not in source:
            return _resolve_python_relative(base_dir, source, indexed_paths)
    return _resolve_path_style(base_dir, source, indexed_paths)


def _resolve_path_style(base_dir: str, source: str, indexed_paths: set[str]) -> str | None:
    joined = os.path.normpath(os.path.join(base_dir, source))
    if joined in indexed_paths:
        return joined
    for ext in _JS_EXTENSIONS:
        if joined + ext in indexed_paths:
            return joined + ext
        index_candidate = os.path.join(joined, f"index{ext}")
        if index_candidate in indexed_paths:
            return index_candidate
    return None


def _resolve_python_relative(base_dir: str, source: str, indexed_paths: set[str]) -> str | None:
    dots = len(source) - len(source.lstrip("."))
    rest = source[dots:]  # e.g. "utils" from ".utils", "pkg.mod" from "..pkg.mod", "" from "."
    # One leading dot means "this package" (the importer's own directory);
    # each additional dot goes up one more directory level.
    target_dir = base_dir
    for _ in range(dots - 1):
        target_dir = os.path.dirname(target_dir)
    segments = rest.split(".") if rest else []
    joined = os.path.normpath(os.path.join(target_dir, *segments)) if segments else target_dir
    for ext in _PY_EXTENSIONS:
        if joined + ext in indexed_paths:
            return joined + ext
        index_candidate = os.path.join(joined, f"__init__{ext}")
        if index_candidate in indexed_paths:
            return index_candidate
    return None


@dataclass(frozen=True)
class FileDependencies:
    internal: tuple[str, ...]  # resolved paths to other indexed files
    external: tuple[str, ...]  # raw import sources that are packages, not files in this repo


def _load_all_imports(conn: sqlite3.Connection) -> list[tuple[str, str, bool]]:
    rows = conn.execute(
        "SELECT f.path, i.source, i.is_relative FROM imports i JOIN files f ON f.id = i.file_id"
    ).fetchall()
    return [(path, source, bool(is_relative)) for path, source, is_relative in rows]


def file_dependencies(conn: sqlite3.Connection, file_path: str) -> FileDependencies:
    indexed_paths = {row[0] for row in conn.execute("SELECT path FROM files").fetchall()}
    internal: list[str] = []
    external: list[str] = []
    for path, source, is_relative in _load_all_imports(conn):
        if path != file_path:
            continue
        resolved = resolve_import_path(path, source, is_relative, indexed_paths)
        (internal if resolved is not None else external).append(resolved or source)
    return FileDependencies(internal=tuple(dict.fromkeys(internal)), external=tuple(dict.fromkeys(external)))


def file_dependents(conn: sqlite3.Connection, file_path: str) -> tuple[str, ...]:
    """The reverse query — the "what would break if I change this file"
    question. Every file whose own resolved internal dependency includes
    `file_path`."""
    indexed_paths = {row[0] for row in conn.execute("SELECT path FROM files").fetchall()}
    dependents: list[str] = []
    for path, source, is_relative in _load_all_imports(conn):
        resolved = resolve_import_path(path, source, is_relative, indexed_paths)
        if resolved == file_path and path not in dependents:
            dependents.append(path)
    return tuple(dependents)


def _build_internal_graph(conn: sqlite3.Connection) -> dict[str, set[str]]:
    indexed_paths = {row[0] for row in conn.execute("SELECT path FROM files").fetchall()}
    graph: dict[str, set[str]] = {p: set() for p in indexed_paths}
    for path, source, is_relative in _load_all_imports(conn):
        resolved = resolve_import_path(path, source, is_relative, indexed_paths)
        if resolved is not None:
            graph.setdefault(path, set()).add(resolved)
    return graph


def find_cycles(conn: sqlite3.Connection) -> list[list[str]]:
    """Circular internal-import chains — real, findable bugs/smells (a
    genuine import cycle, not just "these files are related"). Plain DFS
    with a recursion stack, not a full Tarjan's-SCC implementation: this
    graph is file-count-sized, not edge-count-explosive, and a simple
    cycle finder is easier to verify correct than a fancier one for the
    same result."""
    graph = _build_internal_graph(conn)
    visited: set[str] = set()
    stack: list[str] = []
    on_stack: set[str] = set()
    cycles: list[list[str]] = []

    def dfs(node: str) -> None:
        visited.add(node)
        stack.append(node)
        on_stack.add(node)
        for neighbor in graph.get(node, ()):
            if neighbor in on_stack:
                cycle_start = stack.index(neighbor)
                cycles.append(stack[cycle_start:] + [neighbor])
            elif neighbor not in visited:
                dfs(neighbor)
        stack.pop()
        on_stack.discard(node)

    for node in graph:
        if node not in visited:
            dfs(node)
    return cycles


def dependency_summary(conn: sqlite3.Connection, top_n: int = 10) -> dict:
    """The company-facing headline numbers: which files the rest of the
    codebase leans on most (high blast radius if changed), which files
    nothing internal depends on (candidate entry points, or candidate
    dead files if also unimported by design), and whether there's a real
    import cycle anywhere."""
    graph = _build_internal_graph(conn)
    dependent_counts: dict[str, int] = {p: 0 for p in graph}
    for deps in graph.values():
        for dep in deps:
            dependent_counts[dep] = dependent_counts.get(dep, 0) + 1

    most_depended_on = sorted(dependent_counts.items(), key=lambda kv: kv[1], reverse=True)[:top_n]
    no_dependents = [p for p, count in dependent_counts.items() if count == 0]
    cycles = find_cycles(conn)

    return {
        "most_depended_on": [{"file": f, "dependent_count": c} for f, c in most_depended_on if c > 0],
        "files_with_no_internal_dependents": sorted(no_dependents),
        "cycle_count": len(cycles),
        "cycles": cycles[:top_n],
    }

"""Exposes the structure graph to an agent over MCP — the piece that
turns "a queryable SQLite file" into something a planner/orchestrator
agent can actually call. Month 1's last major deliverable.

Tool *logic* lives in plain functions taking a sqlite3.Connection, kept
separate from the `@server.tool()` registration below them — real MCP
client/transport testing is possible but heavier than this needs; the
thing actually worth unit-testing precisely is "does search_symbols
return the right rows", not "does the stdio transport frame messages
correctly" (that's the SDK's own job, not this module's).

API note: this targets `mcp` 2.x, where `FastMCP` was renamed to
`MCPServer` (`from mcp.server.mcpserver import MCPServer`) — confirmed
directly against the installed package rather than assumed, since the
package's own v1 import path now raises a ModuleNotFoundError with the
migration note built in.
"""

from __future__ import annotations

import sqlite3
from typing import Any

from cairn_graph.actions import Decision, PermissionMode, apply_edit, build_apply_edit_action, decide
from cairn_graph.build import build_graph
from cairn_graph.reachability import compute_dead_symbols
from cairn_graph.store import open_store, stats
from cairn_graph.vectors import build_vector_index, search_semantic


def search_symbols(conn: sqlite3.Connection, query: str, limit: int = 20) -> list[dict[str, Any]]:
    """Find symbols by name substring — the graph's basic "what is this
    called, where does it live" lookup."""
    rows = conn.execute(
        "SELECT s.kind, s.name, s.exported, s.parent, f.path, s.start_line, s.end_line "
        "FROM symbols s JOIN files f ON f.id = s.file_id "
        "WHERE s.name LIKE ? ORDER BY s.exported DESC, f.path LIMIT ?",
        (f"%{query}%", limit),
    ).fetchall()
    return [
        {
            "kind": kind,
            "name": name,
            "exported": bool(exported),
            "parent": parent,
            "file": path,
            "start_line": start_line,
            "end_line": end_line,
        }
        for kind, name, exported, parent, path, start_line, end_line in rows
    ]


def get_symbol_usages(conn: sqlite3.Connection, name: str, limit: int = 50) -> dict[str, Any]:
    """Everywhere a name is called, instantiated, or otherwise referenced
    — the "what happens if I change this" question an agent needs before
    touching anything, not just "does this symbol exist"."""
    calls = conn.execute(
        "SELECT c.caller, f.path, c.line FROM calls c JOIN files f ON f.id = c.file_id WHERE c.callee = ? LIMIT ?",
        (name, limit),
    ).fetchall()
    refs = conn.execute(
        "SELECT r.referrer, f.path, r.line FROM references_ r JOIN files f ON f.id = r.file_id WHERE r.name = ? LIMIT ?",
        (name, limit),
    ).fetchall()
    return {
        "name": name,
        "called_from": [{"caller": caller, "file": path, "line": line} for caller, path, line in calls],
        "referenced_from": [{"referrer": referrer, "file": path, "line": line} for referrer, path, line in refs],
    }


def find_dead_code(conn: sqlite3.Connection, limit: int = 50) -> dict[str, Any]:
    """Unexported symbols unreachable from any export or known framework
    entry point — see reachability.py and the README for exactly what
    this does and does not catch."""
    result = compute_dead_symbols(conn)
    dead = result.dead[:limit]
    return {
        "reachable_count": result.reachable_count,
        "dead_count": len(result.dead),
        "dead_symbols": [{"kind": s.kind, "name": s.name, "file": s.file_path} for s in dead],
        "truncated": len(result.dead) > limit,
    }


def get_index_stats(conn: sqlite3.Connection) -> dict[str, int]:
    return stats(conn)


def apply_edit_gated(
    root: str,
    file_path: str,
    old_text: str,
    new_text: str,
    mode: PermissionMode,
    approved: bool = False,
) -> dict[str, Any]:
    """The permission gate applied to one concrete action. `approved` is
    how the orchestrator answers its own popup on a second call — the
    same shape as this agent's own tool-permission flow: ask once, then
    proceed once the human has said yes. A CRITICAL action would refuse
    even with approved=True on this path (there isn't one wired up yet);
    REVIEW actions proceed once either the mode allows it outright or the
    caller has already gotten a yes."""
    action = build_apply_edit_action(root, file_path, old_text, new_text)
    decision = decide(action, mode)
    if decision is Decision.NEEDS_APPROVAL and not approved:
        return {"status": "needs_approval", "risk": action.risk.value, "description": action.description}
    result = apply_edit(root, file_path, old_text, new_text)
    return {"status": "applied", **result}


def semantic_search(vector_dir: str, query: str, limit: int = 10, embed_fn=None) -> dict[str, Any]:
    """Find code by what it does, not what it's named — the complement to
    `search_symbols`'s substring match. Returns an empty list, not an
    error, when `vectorize` hasn't been run yet. `embed_fn` exists so
    tests can inject a deterministic embedder instead of loading the real
    model."""
    results = search_semantic(vector_dir, query, limit=limit, embed_fn=embed_fn)
    return {"query": query, "results": results}


def reindex(db_path: str, root: str, workers: int | None = None) -> dict[str, Any]:
    """Lets an agent trigger a re-index after making changes, instead of
    only ever serving whatever was indexed at server startup — the graph
    would otherwise silently drift from the actual codebase the longer a
    session runs."""
    summary = build_graph(root, db_path, workers=workers)
    return {
        "total_files_seen": summary.total_files_seen,
        "parsed": summary.parsed,
        "skipped_unchanged": summary.skipped_unchanged,
        "failed": summary.failed,
        "removed": summary.removed,
        "duration_seconds": round(summary.duration_seconds, 3),
        "failures": summary.failures[:20],
    }


def build_server(
    db_path: str,
    root: str,
    vector_dir: str = ".cairn-graph-vectors",
    permission_mode: PermissionMode = PermissionMode.REVIEW,
):
    """Constructs the MCPServer with tools bound to one open connection —
    factored out from `main()` so tests can construct a server against a
    temp db without going through argv/stdio. Defaults to REVIEW mode
    (everything mutating stops and asks) — AUTO mode is opt-in, not the
    default a server silently starts in."""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        "cairn-graph",
        instructions=(
            "Query Cairn's structure graph for a codebase: search symbols "
            "by name, search by meaning, see where a name is used, find "
            "unreferenced dead code, or re-index after changes. Name-based "
            "results are exact but not type-resolved; semantic results are "
            "similarity ranked, not exact — treat both as strong hints, "
            "not proof. apply_edit_tool is gated: a needs_approval response "
            "means show the description to the human and call again with "
            "approved=true only after they say yes — never on your own."
        ),
    )
    conn = open_store(db_path)

    @server.tool()
    def search(query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Find symbols (functions, classes, methods, types) by name substring."""
        return search_symbols(conn, query, limit)

    @server.tool()
    def usages(name: str, limit: int = 50) -> dict[str, Any]:
        """Find every place a symbol is called or referenced, by exact name."""
        return get_symbol_usages(conn, name, limit)

    @server.tool()
    def dead_code(limit: int = 50) -> dict[str, Any]:
        """List unexported symbols unreachable from any export or known entry point."""
        return find_dead_code(conn, limit)

    @server.tool()
    def stats_tool() -> dict[str, int]:
        """Report index size: file/symbol/import/call counts, parse failures."""
        return get_index_stats(conn)

    @server.tool()
    def reindex_tool(workers: int | None = None) -> dict[str, Any]:
        """Re-scan the codebase and update the index — only changed files are re-parsed."""
        nonlocal conn
        result = reindex(db_path, root, workers)
        conn.close()
        conn = open_store(db_path)
        return result

    @server.tool()
    def semantic(query: str, limit: int = 10) -> dict[str, Any]:
        """Search the codebase by meaning rather than name — e.g. "sums up
        line item prices" can find `calculateInvoiceTotal`. Requires
        `vectorize_tool` to have been run at least once; returns an empty
        result list otherwise, not an error."""
        return semantic_search(vector_dir, query, limit)

    @server.tool()
    def vectorize_tool() -> dict[str, Any]:
        """Embed every symbol in the current graph into the semantic index —
        run once after the first `build`, and again whenever `semantic`
        results feel stale relative to `reindex_tool`."""
        summary = build_vector_index(db_path, vector_dir)
        return {"symbols_embedded": summary.symbols_embedded, "batches": summary.batches}

    @server.tool()
    def apply_edit_tool(file_path: str, old_text: str, new_text: str, approved: bool = False) -> dict[str, Any]:
        """Replace one exact, unique occurrence of old_text with new_text in
        a file inside the indexed root. old_text must match exactly once —
        this refuses rather than guessing which occurrence you meant. May
        return status="needs_approval" instead of editing anything; see the
        server instructions for how to handle that."""
        return apply_edit_gated(root, file_path, old_text, new_text, permission_mode, approved)

    return server


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="cairn-graph-mcp")
    parser.add_argument("root", help="directory the graph indexes")
    parser.add_argument("--db", default=".cairn-graph.db")
    parser.add_argument("--vectors", default=".cairn-graph-vectors")
    parser.add_argument("--transport", default="stdio", choices=["stdio", "sse", "streamable-http"])
    parser.add_argument("--mode", default="review", choices=["review", "auto"], help="permission mode for mutating tools")
    args = parser.parse_args()

    server = build_server(args.db, args.root, args.vectors, PermissionMode(args.mode))
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()

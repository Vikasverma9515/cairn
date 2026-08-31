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

from cairn_graph.build import build_graph
from cairn_graph.reachability import compute_dead_symbols
from cairn_graph.store import open_store, stats


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


def build_server(db_path: str, root: str):
    """Constructs the MCPServer with tools bound to one open connection —
    factored out from `main()` so tests can construct a server against a
    temp db without going through argv/stdio."""
    from mcp.server.mcpserver import MCPServer

    server = MCPServer(
        "cairn-graph",
        instructions=(
            "Query Cairn's structure graph for a codebase: search symbols, "
            "see where a name is used, find unreferenced dead code, or "
            "re-index after changes. Everything here is name-based, not "
            "type-resolved — treat results as strong hints, not proof."
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

    return server


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="cairn-graph-mcp")
    parser.add_argument("root", help="directory the graph indexes")
    parser.add_argument("--db", default=".cairn-graph.db")
    parser.add_argument("--transport", default="stdio", choices=["stdio", "sse", "streamable-http"])
    args = parser.parse_args()

    server = build_server(args.db, args.root)
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()

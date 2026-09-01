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

Threading note, found live: the SDK runs each sync tool function on a
worker thread (`anyio.to_thread.run_sync`), not the thread that built
this server — a plain `search_symbols(conn, ...)` call in a test never
exercises this, only a real `await server.call_tool(...)` does. Every
tool closure below that touches `conn` or `memory_conn` holds `_lock`
for the duration of the call, both to satisfy sqlite3's same-connection
access rules safely (the connections are opened with
`check_same_thread=False`) and to keep two concurrent tool calls from
touching one connection at once.
"""

from __future__ import annotations

import sqlite3
import threading
from typing import Any, Callable

from cairn_graph.actions import (
    ActionRequest,
    Decision,
    PermissionMode,
    apply_edit,
    build_apply_edit_action,
    build_create_file_action,
    build_delete_file_action,
    build_run_command_action,
    create_file,
    decide,
    delete_file,
    run_command,
)
from cairn_graph.analytics import action_summary, approval_rate, customer_overview, daily_activity, top_tools
from cairn_graph.build import build_graph
from cairn_graph.dashboard import assemble_dashboard_data, generate_narrative, render_dashboard_html
from cairn_graph.dependencies import dependency_summary, file_dependencies, file_dependents
from cairn_graph.memory import open_memory_store, recall, recent_history, record_turn, remember
from cairn_graph.reachability import compute_dead_symbols
from cairn_graph.store import get_pending_action, list_action_log, log_action, open_store, resolve_action, stats
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


def _gate(
    action: ActionRequest,
    mode: PermissionMode,
    approved: bool,
    execute: Callable[[], dict],
    applied_status: str,
    conn: sqlite3.Connection | None = None,
    customer_id: str | None = None,
    request_id: int | None = None,
) -> dict[str, Any]:
    """The one place every gated tool below funnels through: decide, log
    the decision either way, then either stop or actually do the thing.
    `conn` is optional so the plain action functions stay testable without
    a graph db — production calls (from `build_server`) always pass one.

    **`approved=true` alone proves nothing** — it's a plain argument the
    calling model controls, so a prompt-injected instruction (or a client
    that doesn't actually wait for a human) could set it on the very
    first call and skip the gate entirely. When a real `conn` is present,
    approval must reference the exact `request_id` a prior
    `needs_approval` response returned: the pending row has to exist,
    still be unresolved, and describe the *same* action being retried.
    Without a matching `request_id`, `approved=true` is refused, not
    trusted — the caller gets a fresh `needs_approval` instead of a free
    pass. (With no `conn` — the unit-test path — there's no log to check
    against, so `approved` is honored directly, same as before.)"""
    decision = decide(action, mode)
    if decision is Decision.NEEDS_APPROVAL:
        verified = approved
        if approved and conn is not None:
            verified = False
            if request_id is not None:
                pending = get_pending_action(conn, request_id)
                if (
                    pending is not None
                    and pending.outcome == "needs_approval"
                    and pending.tool_name == action.tool_name
                    and pending.description == action.description
                ):
                    verified = True
        if not verified:
            new_id = None
            if conn is not None:
                new_id = log_action(conn, action.tool_name, action.description, action.risk.value, "needs_approval", customer_id)
            response = {"status": "needs_approval", "risk": action.risk.value, "description": action.description}
            if new_id is not None:
                response["request_id"] = new_id
            return response
        # verified: either a real, still-pending, matching approval (conn path — resolve that
        # row instead of inserting a duplicate), or the no-conn unit-test path with nothing to log
        result = execute()
        if conn is not None:
            resolve_action(conn, request_id, applied_status)
        return {"status": applied_status, **result}
    result = execute()
    if conn is not None:
        log_action(conn, action.tool_name, action.description, action.risk.value, applied_status, customer_id)
    return {"status": applied_status, **result}


def apply_edit_gated(
    root: str,
    file_path: str,
    old_text: str,
    new_text: str,
    mode: PermissionMode,
    approved: bool = False,
    conn: sqlite3.Connection | None = None,
    request_id: int | None = None,
) -> dict[str, Any]:
    """`approved` is how the orchestrator answers its own popup on a
    second call — the same shape as this agent's own tool-permission
    flow: ask once, then proceed once the human has said yes. When `conn`
    is a real connection, `approved=true` alone isn't enough — `request_id`
    must match the pending row a prior `needs_approval` call created; see
    `_gate`'s docstring for why."""
    action = build_apply_edit_action(root, file_path, old_text, new_text)
    return _gate(action, mode, approved, lambda: apply_edit(root, file_path, old_text, new_text), "applied", conn, request_id=request_id)


def create_file_gated(
    root: str,
    file_path: str,
    content: str,
    mode: PermissionMode,
    approved: bool = False,
    conn: sqlite3.Connection | None = None,
    request_id: int | None = None,
) -> dict[str, Any]:
    action = build_create_file_action(root, file_path, content)
    return _gate(action, mode, approved, lambda: create_file(root, file_path, content), "applied", conn, request_id=request_id)


def delete_file_gated(
    root: str,
    file_path: str,
    mode: PermissionMode,
    approved: bool = False,
    conn: sqlite3.Connection | None = None,
    request_id: int | None = None,
) -> dict[str, Any]:
    action = build_delete_file_action(root, file_path)
    return _gate(action, mode, approved, lambda: delete_file(root, file_path), "applied", conn, request_id=request_id)


def run_command_gated(
    root: str,
    command: list[str],
    mode: PermissionMode,
    approved: bool = False,
    conn: sqlite3.Connection | None = None,
    request_id: int | None = None,
) -> dict[str, Any]:
    """CRITICAL tier means `decide()` returns NEEDS_APPROVAL here in every
    mode — the `mode` argument only exists to keep the same shape as the
    other gated functions; it never changes the outcome for a CRITICAL
    action, by design."""
    action = build_run_command_action(command)
    return _gate(action, mode, approved, lambda: run_command(root, command), "ran", conn, request_id=request_id)


def audit_log(conn: sqlite3.Connection, limit: int = 50, customer_id: str | None = None) -> dict[str, Any]:
    entries = list_action_log(conn, limit, customer_id)
    return {
        "entries": [
            {
                "tool_name": e.tool_name,
                "description": e.description,
                "risk": e.risk,
                "outcome": e.outcome,
                "customer_id": e.customer_id,
                "created_at": e.created_at,
            }
            for e in entries
        ]
    }


def get_file_dependencies(conn: sqlite3.Connection, file_path: str) -> dict[str, Any]:
    deps = file_dependencies(conn, file_path)
    return {"file": file_path, "internal": list(deps.internal), "external": list(deps.external)}


def get_file_dependents(conn: sqlite3.Connection, file_path: str) -> dict[str, Any]:
    """The "what would break if I change this file" query — every other
    indexed file whose own import resolves to `file_path`."""
    return {"file": file_path, "dependents": list(file_dependents(conn, file_path))}


def get_dependency_summary(conn: sqlite3.Connection, top_n: int = 10) -> dict[str, Any]:
    return dependency_summary(conn, top_n)


def get_dashboard(
    conn: sqlite3.Connection,
    memory_conn: sqlite3.Connection,
    customer_id: str | None = None,
    llm_provider=None,
    title: str = "Cairn Dashboard",
) -> dict[str, Any]:
    """Assembles the real data, asks `llm_provider` for a grounded read of
    it (skipped — narrative says so plainly — if no provider is given),
    and renders the self-contained HTML page. `llm_provider` is injected
    so this stays testable without a network call; production callers
    pass a real one loaded via `providers.load_provider`."""
    data = assemble_dashboard_data(conn, memory_conn, customer_id)
    narrative = (
        generate_narrative(data, llm_provider)
        if llm_provider is not None
        else "No LLM provider configured for this dashboard — showing raw data only."
    )
    return {"narrative": narrative, "html": render_dashboard_html(data, narrative, title)}


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
    memory_db: str = ".cairn-graph-memory.db",
    dashboard_llm_provider_name: str | None = None,
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
            "not proof. apply_edit_tool, create_file_tool, delete_file_tool, "
            "and run_command_tool are gated: a needs_approval response "
            "includes a request_id — show the description to the human and "
            "call again with approved=true AND that exact request_id only "
            "after they say yes, never on your own. approved=true without "
            "the matching request_id is refused, not honored. "
            "delete_file_tool and run_command_tool always need approval, "
            "in either permission mode. audit_log_tool lists what's been "
            "attempted so far, applied or not. file_dependencies_tool/"
            "file_dependents_tool/dependency_summary_tool answer "
            "file-level questions (only relative imports resolve to an "
            "internal edge — a package import is reported as external). "
            "dashboard_tool returns a full HTML report plus a grounded, "
            "LLM-generated read of the real data — never present its "
            "narrative as containing anything beyond what the data shows."
        ),
    )
    conn = open_store(db_path)
    memory_conn = open_memory_store(memory_db)
    _lock = threading.Lock()

    @server.tool()
    def search(query: str, limit: int = 20) -> list[dict[str, Any]]:
        """Find symbols (functions, classes, methods, types) by name substring."""
        with _lock:
            return search_symbols(conn, query, limit)

    @server.tool()
    def usages(name: str, limit: int = 50) -> dict[str, Any]:
        """Find every place a symbol is called or referenced, by exact name."""
        with _lock:
            return get_symbol_usages(conn, name, limit)

    @server.tool()
    def dead_code(limit: int = 50) -> dict[str, Any]:
        """List unexported symbols unreachable from any export or known entry point."""
        with _lock:
            return find_dead_code(conn, limit)

    @server.tool()
    def stats_tool() -> dict[str, int]:
        """Report index size: file/symbol/import/call counts, parse failures."""
        with _lock:
            return get_index_stats(conn)

    @server.tool()
    def reindex_tool(workers: int | None = None) -> dict[str, Any]:
        """Re-scan the codebase and update the index — only changed files are re-parsed."""
        nonlocal conn
        with _lock:
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
    def apply_edit_tool(file_path: str, old_text: str, new_text: str, approved: bool = False, request_id: int | None = None) -> dict[str, Any]:
        """Replace one exact, unique occurrence of old_text with new_text in
        a file inside the indexed root. old_text must match exactly once —
        this refuses rather than guessing which occurrence you meant. May
        return status="needs_approval" plus a request_id instead of editing
        anything — show the description to the human, and only call again
        with approved=true AND that exact request_id once they say yes.
        approved=true without the matching request_id is refused, not
        trusted — it does not skip the gate."""
        with _lock:
            return apply_edit_gated(root, file_path, old_text, new_text, permission_mode, approved, conn, request_id)

    @server.tool()
    def create_file_tool(file_path: str, content: str, approved: bool = False, request_id: int | None = None) -> dict[str, Any]:
        """Create a new file inside the indexed root. Refuses if the file
        already exists — use apply_edit_tool to modify one. Same
        needs_approval + request_id flow as apply_edit_tool."""
        with _lock:
            return create_file_gated(root, file_path, content, permission_mode, approved, conn, request_id)

    @server.tool()
    def delete_file_tool(file_path: str, approved: bool = False, request_id: int | None = None) -> dict[str, Any]:
        """Delete a file inside the indexed root. CRITICAL risk — always
        returns status="needs_approval" plus a request_id on the first
        call, in either permission mode. Call again with approved=true and
        that exact request_id only after a human has actually said yes."""
        with _lock:
            return delete_file_gated(root, file_path, permission_mode, approved, conn, request_id)

    @server.tool()
    def run_command_tool(command: list[str], approved: bool = False, request_id: int | None = None) -> dict[str, Any]:
        """Run a shell command (argv list, e.g. ["npm", "test"]) with cwd
        pinned to the indexed root. CRITICAL risk — always returns
        status="needs_approval" plus a request_id on the first call, in
        either permission mode; call again with approved=true and that
        exact request_id only once a human has actually said yes."""
        # Held for the whole subprocess duration, so a long-running command
        # blocks other tool calls until it (or its timeout) finishes — an
        # accepted tradeoff for a rare, always-gated action, not something
        # worth a real work queue over yet.
        with _lock:
            return run_command_gated(root, command, permission_mode, approved, conn, request_id)

    @server.tool()
    def audit_log_tool(limit: int = 50) -> dict[str, Any]:
        """Every gated-action decision so far, most recent first: what was
        attempted, its risk tier, and whether it was applied or is still
        waiting on approval."""
        with _lock:
            return audit_log(conn, limit)

    @server.tool()
    def remember_tool(customer_id: str, key: str, value: str) -> dict[str, Any]:
        """Store a durable, keyed fact about one customer — a preference or
        observation that should overwrite any previous value for that key,
        not accumulate (e.g. remember_tool("acme", "framework", "nextjs"))."""
        with _lock:
            remember(memory_conn, customer_id, key, value)
        return {"status": "stored", "customer_id": customer_id, "key": key}

    @server.tool()
    def recall_tool(customer_id: str, key: str | None = None) -> dict[str, str]:
        """Every remembered fact for one customer, or just one key's value
        if given. Empty dict if nothing's been remembered yet — not an
        error."""
        with _lock:
            return recall(memory_conn, customer_id, key)

    @server.tool()
    def record_turn_tool(customer_id: str, role: str, content: str) -> dict[str, Any]:
        """Append one turn to a customer's conversation history — call this
        for both sides of the conversation (role="user" / role="assistant")
        so recent_history_tool can reconstruct real session continuity."""
        with _lock:
            record_turn(memory_conn, customer_id, role, content)
        return {"status": "recorded"}

    @server.tool()
    def recent_history_tool(customer_id: str, limit: int = 20) -> dict[str, Any]:
        """The last `limit` conversation turns for one customer, oldest
        first — ready to drop straight into a prompt."""
        with _lock:
            turns = recent_history(memory_conn, customer_id, limit)
        return {"turns": [{"role": t.role, "content": t.content, "created_at": t.created_at} for t in turns]}

    @server.tool()
    def analytics_tool(customer_id: str | None = None, since_days: int | None = None) -> dict[str, Any]:
        """Usage analytics for a dashboard: action counts by outcome and
        risk tier, the most-used tools, daily activity for the last 30
        days, and the approval rate (fraction of gated decisions that
        actually proceeded). Omit customer_id for a company-wide view."""
        with _lock:
            return {
                "summary": action_summary(conn, customer_id, since_days),
                "top_tools": top_tools(conn, customer_id),
                "daily_activity": daily_activity(conn, customer_id),
                "approval_rate": approval_rate(conn, customer_id),
            }

    @server.tool()
    def customer_overview_tool() -> dict[str, Any]:
        """The customer roster for a company-facing dashboard: every
        customer who has taken an action or had a conversation turn
        recorded, with counts of each."""
        with _lock:
            overview = customer_overview(conn, memory_conn)
        return {
            "customers": [
                {"customer_id": c.customer_id, "action_count": c.action_count, "conversation_turn_count": c.conversation_turn_count}
                for c in overview
            ]
        }

    @server.tool()
    def file_dependencies_tool(file_path: str) -> dict[str, Any]:
        """What one file depends on: internal (resolved to another
        indexed file — only relative imports resolve) and external
        (package imports, reported as-written, not a file in this repo)."""
        with _lock:
            return get_file_dependencies(conn, file_path)

    @server.tool()
    def file_dependents_tool(file_path: str) -> dict[str, Any]:
        """The reverse of file_dependencies_tool: every indexed file that
        imports this one — the "what would break if I change this file"
        question, at file granularity."""
        with _lock:
            return get_file_dependents(conn, file_path)

    @server.tool()
    def dependency_summary_tool(top_n: int = 10) -> dict[str, Any]:
        """Company-facing headline numbers for the dependency graph: the
        most-depended-on files (high blast radius if changed), files
        nothing internal depends on (candidate entry points), and any
        real import cycle found."""
        with _lock:
            return get_dependency_summary(conn, top_n)

    @server.tool()
    def dashboard_tool(customer_id: str | None = None) -> dict[str, Any]:
        """A company-facing analytics dashboard as a self-contained HTML
        page (open directly in a browser), plus the standalone narrative
        text. Includes an LLM-generated read of what this codebase/company
        seems to be building and how they're using the agent, grounded in
        the real collected data — never invented. Omit customer_id for a
        company-wide view. Uses the LLM provider this server was
        configured with (`--dashboard-llm-provider`); if none is
        configured, the narrative says so plainly instead of guessing."""
        from cairn_graph.providers import llm_registry, load_provider

        provider = None
        if dashboard_llm_provider_name is not None:
            provider = load_provider(llm_registry, "CAIRN_LLM_PROVIDER", "echo", provider_name=dashboard_llm_provider_name)
        with _lock:
            return get_dashboard(conn, memory_conn, customer_id, provider)

    return server


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="cairn-graph-mcp")
    parser.add_argument("root", help="directory the graph indexes")
    parser.add_argument("--db", default=".cairn-graph.db")
    parser.add_argument("--vectors", default=".cairn-graph-vectors")
    parser.add_argument("--memory-db", default=".cairn-graph-memory.db")
    parser.add_argument("--transport", default="stdio", choices=["stdio", "sse", "streamable-http"])
    parser.add_argument("--mode", default="review", choices=["review", "auto"], help="permission mode for mutating tools")
    parser.add_argument("--dashboard-llm-provider", default=None, help="LLM provider name (e.g. groq) for dashboard_tool's narrative")
    args = parser.parse_args()

    server = build_server(args.db, args.root, args.vectors, PermissionMode(args.mode), args.memory_db, args.dashboard_llm_provider)
    server.run(transport=args.transport)


if __name__ == "__main__":
    main()

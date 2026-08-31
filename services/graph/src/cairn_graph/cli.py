"""`cairn-graph build <dir> [--db path]` / `cairn-graph query <term> [--db path]`

Deliberately minimal — this CLI exists to make the engine testable and
dogfoodable on real repos while the rest of the platform (MCP server,
orchestrator) is built on top of it, not as the final interface end
users see.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time

from cairn_graph.build import build_graph


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="cairn-graph")
    sub = parser.add_subparsers(dest="command", required=True)

    build_p = sub.add_parser("build", help="index a directory into the structure graph")
    build_p.add_argument("root")
    build_p.add_argument("--db", default=".cairn-graph.db")
    build_p.add_argument("--workers", type=int, default=None)

    query_p = sub.add_parser("query", help="look up a symbol by name")
    query_p.add_argument("term")
    query_p.add_argument("--db", default=".cairn-graph.db")

    stats_p = sub.add_parser("stats", help="print index size / health")
    stats_p.add_argument("--db", default=".cairn-graph.db")

    dead_p = sub.add_parser("dead", help="list unexported symbols unreachable from any export")
    dead_p.add_argument("--db", default=".cairn-graph.db")

    args = parser.parse_args(argv)

    if args.command == "build":
        return _run_build(args.root, args.db, args.workers)
    if args.command == "query":
        return _run_query(args.term, args.db)
    if args.command == "stats":
        return _run_stats(args.db)
    if args.command == "dead":
        return _run_dead(args.db)
    return 1


def _run_build(root: str, db: str, workers: int | None) -> int:
    start = time.time()
    summary = build_graph(root, db, workers=workers)
    elapsed = time.time() - start
    print(
        f"cairn-graph build: {summary.total_files_seen} file(s) seen, "
        f"{summary.parsed} parsed, {summary.skipped_unchanged} unchanged/skipped, "
        f"{summary.failed} failed, {summary.removed} removed — {elapsed:.2f}s"
    )
    for path, error in summary.failures[:20]:
        print(f"  failed: {path} — {error}", file=sys.stderr)
    if len(summary.failures) > 20:
        print(f"  ...and {len(summary.failures) - 20} more failures", file=sys.stderr)
    print(f"wrote {db}")
    return 0


def _run_query(term: str, db: str) -> int:
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT s.kind, s.name, s.exported, s.parent, f.path, s.start_line "
        "FROM symbols s JOIN files f ON f.id = s.file_id "
        "WHERE s.name LIKE ? ORDER BY s.exported DESC, f.path LIMIT 50",
        (f"%{term}%",),
    ).fetchall()
    if not rows:
        print(f"no symbols matching {term!r}")
        return 0
    for kind, name, exported, parent, path, line in rows:
        marker = "export" if exported else "      "
        parent_note = f" (in {parent})" if parent else ""
        print(f"{marker}  {kind:12s} {name}{parent_note}  —  {path}:{line}")
    return 0


def _run_stats(db: str) -> int:
    from cairn_graph.store import stats

    conn = sqlite3.connect(db)
    for key, value in stats(conn).items():
        print(f"{key}: {value}")
    return 0


def _run_dead(db: str) -> int:
    from cairn_graph.reachability import compute_dead_symbols

    conn = sqlite3.connect(db)
    result = compute_dead_symbols(conn)
    if not result.dead:
        print(f"no dead symbols found ({result.reachable_count} reachable)")
        return 0
    print(f"{len(result.dead)} unreachable, unexported symbol(s) ({result.reachable_count} reachable):")
    for sym in result.dead:
        print(f"  {sym.kind:10s} {sym.name}  —  {sym.file_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

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

    vectorize_p = sub.add_parser("vectorize", help="embed every symbol into the semantic (vector) index")
    vectorize_p.add_argument("--db", default=".cairn-graph.db")
    vectorize_p.add_argument("--vectors", default=".cairn-graph-vectors")

    semantic_p = sub.add_parser("semantic", help="search the graph by meaning, not name")
    semantic_p.add_argument("query")
    semantic_p.add_argument("--vectors", default=".cairn-graph-vectors")
    semantic_p.add_argument("--limit", type=int, default=10)

    route_p = sub.add_parser("route", help="show which specialist agent would handle a request, and its scoped toolset")
    route_p.add_argument("request")

    sub.add_parser("doctor", help="check that this install actually works before relying on it")

    deps_p = sub.add_parser("deps", help="file-level dependency graph: most-depended-on files, entry points, cycles")
    deps_p.add_argument("--db", default=".cairn-graph.db")
    deps_p.add_argument("--top", type=int, default=10)

    dash_p = sub.add_parser("dashboard", help="write a company-facing analytics dashboard as a self-contained HTML file")
    dash_p.add_argument("--db", default=".cairn-graph.db")
    dash_p.add_argument("--memory-db", default=".cairn-graph-memory.db")
    dash_p.add_argument("--customer", default=None, help="scope to one customer id; omit for a company-wide view")
    dash_p.add_argument("--llm-provider", default=None, help="LLM provider name (e.g. groq) for the narrative; omit to skip it")
    dash_p.add_argument("--out", default="cairn-dashboard.html")

    voice_p = sub.add_parser("voice-turn", help="run one real audio-in/text-or-audio-out conversation turn through STT -> orchestrator -> LLM -> TTS")
    voice_p.add_argument("audio_file", help="path to a WAV file with the user's speech")
    voice_p.add_argument("--stt-provider", default="deepgram")
    voice_p.add_argument("--llm-provider", default="groq")
    voice_p.add_argument("--tts-provider", default=None, help="omit to skip audio synthesis and get text-only output")
    voice_p.add_argument("--customer", default=None)
    voice_p.add_argument("--memory-db", default=".cairn-graph-memory.db")
    voice_p.add_argument("--out-audio", default=None, help="path to write the synthesized reply audio to, if --tts-provider is given")

    args = parser.parse_args(argv)

    if args.command == "build":
        return _run_build(args.root, args.db, args.workers)
    if args.command == "query":
        return _run_query(args.term, args.db)
    if args.command == "stats":
        return _run_stats(args.db)
    if args.command == "dead":
        return _run_dead(args.db)
    if args.command == "vectorize":
        return _run_vectorize(args.db, args.vectors)
    if args.command == "semantic":
        return _run_semantic(args.query, args.vectors, args.limit)
    if args.command == "route":
        return _run_route(args.request)
    if args.command == "doctor":
        return _run_doctor()
    if args.command == "deps":
        return _run_deps(args.db, args.top)
    if args.command == "dashboard":
        return _run_dashboard(args.db, args.memory_db, args.customer, args.llm_provider, args.out)
    if args.command == "voice-turn":
        return _run_voice_turn(
            args.audio_file, args.stt_provider, args.llm_provider, args.tts_provider, args.customer, args.memory_db, args.out_audio
        )
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


def _run_vectorize(db: str, vectors: str) -> int:
    from cairn_graph.vectors import build_vector_index

    start = time.time()
    summary = build_vector_index(db, vectors)
    elapsed = time.time() - start
    print(f"cairn-graph vectorize: {summary.symbols_embedded} symbol(s) embedded in {summary.batches} batch(es) — {elapsed:.2f}s")
    print(f"wrote {vectors}")
    return 0


def _run_semantic(query: str, vectors: str, limit: int) -> int:
    from cairn_graph.vectors import search_semantic

    results = search_semantic(vectors, query, limit=limit)
    if not results:
        print(f"no semantic matches for {query!r} (index empty or missing — run `vectorize` first?)")
        return 0
    for r in results:
        parent_note = f" (in {r['parent']})" if r.get("parent") else ""
        print(f"{r['score']:.3f}  {r['kind']:10s} {r['name']}{parent_note}  —  {r['file']}:{r['start_line']}")
    return 0


def _run_route(request: str) -> int:
    from cairn_graph.orchestrator import route_request

    result = route_request(request)
    print(f"specialist: {result['specialist']}")
    print("scoped tools:")
    for tool in result["available_tools"]:
        print(f"  {tool}")
    return 0


def _run_doctor() -> int:
    from cairn_graph.doctor import run_checks

    results = run_checks()
    any_failed = False
    for r in results:
        if not r.ok:
            any_failed = True
            marker = "FAIL"
        elif r.warning:
            marker = "WARN"
        else:
            marker = " OK "
        print(f"[{marker}] {r.name}: {r.detail}")
    if any_failed:
        print("\ncairn-graph doctor: one or more checks failed — see FAIL lines above", file=sys.stderr)
        return 1
    print("\ncairn-graph doctor: all checks passed")
    return 0


def _run_deps(db: str, top_n: int) -> int:
    import sqlite3

    from cairn_graph.dependencies import dependency_summary

    conn = sqlite3.connect(db)
    summary = dependency_summary(conn, top_n)
    print(f"most depended-on files (top {top_n}):")
    for row in summary["most_depended_on"]:
        print(f"  {row['dependent_count']:3d}  {row['file']}")
    print(f"\n{len(summary['files_with_no_internal_dependents'])} file(s) with no internal dependents (candidate entry points)")
    if summary["cycle_count"] == 0:
        print("\nno import cycles found")
    else:
        print(f"\n{summary['cycle_count']} import cycle(s) found:")
        for cycle in summary["cycles"]:
            print("  " + " -> ".join(cycle))
    return 0


def _run_dashboard(db: str, memory_db: str, customer_id: str | None, llm_provider_name: str | None, out: str) -> int:
    from cairn_graph.dashboard import assemble_dashboard_data, generate_narrative, render_dashboard_html
    from cairn_graph.memory import open_memory_store
    from cairn_graph.store import open_store

    conn = open_store(db)
    memory_conn = open_memory_store(memory_db)
    data = assemble_dashboard_data(conn, memory_conn, customer_id)

    if llm_provider_name is not None:
        from cairn_graph.providers import llm_registry, load_provider

        provider = load_provider(llm_registry, "CAIRN_LLM_PROVIDER", "echo", provider_name=llm_provider_name)
        narrative = generate_narrative(data, provider)
    else:
        narrative = "No --llm-provider given — showing raw data only."

    html = render_dashboard_html(data, narrative)
    with open(out, "w") as f:
        f.write(html)
    print(f"wrote {out}")
    print(f"narrative: {narrative}")
    return 0


def _run_voice_turn(
    audio_file: str,
    stt_provider_name: str,
    llm_provider_name: str,
    tts_provider_name: str | None,
    customer_id: str | None,
    memory_db: str,
    out_audio: str | None,
) -> int:
    from cairn_graph.memory import open_memory_store
    from cairn_graph.providers import llm_registry, load_provider, stt_registry, tts_registry
    from cairn_graph.voice_pipeline import run_voice_turn

    stt = load_provider(stt_registry, "CAIRN_STT_PROVIDER", "unconfigured", provider_name=stt_provider_name)
    llm = load_provider(llm_registry, "CAIRN_LLM_PROVIDER", "echo", provider_name=llm_provider_name)
    tts = load_provider(tts_registry, "CAIRN_TTS_PROVIDER", "unconfigured", provider_name=tts_provider_name) if tts_provider_name else None
    memory_conn = open_memory_store(memory_db) if customer_id else None

    with open(audio_file, "rb") as f:
        audio_in = f.read()

    result = run_voice_turn(audio_in, stt=stt, llm=llm, tts=tts, customer_id=customer_id, memory_conn=memory_conn)

    print(f"transcript: {result.transcript!r}")
    print(f"routed to: {result.specialist} (tools: {', '.join(result.available_tools)})")
    print(f"reply: {result.reply_text!r}")
    print("timing (ms):", {k: round(v, 1) for k, v in result.timing_ms.items()})
    if result.reply_audio is not None and out_audio is not None:
        with open(out_audio, "wb") as f:
            f.write(result.reply_audio)
        print(f"wrote reply audio to {out_audio}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

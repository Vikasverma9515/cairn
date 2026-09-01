"""Company-facing analytics dashboard — pillar 7, made "smart" per an
explicit ask: not just charts, a short LLM-generated narrative
synthesizing what the real collected data says about what this company
is building and using the agent for. Assembles data from analytics.py +
dependencies.py + memory.py + store.py; given an `LLMProvider`, writes
one grounded paragraph from it — grounded meaning the prompt hands the
model the real numbers and real conversation text and asks it to
characterize them, never to invent anything not in the data.

Rendering is server-side HTML generation (a Python function returning a
string), not a separate JS frontend — matches this service's
Python-only-backend scope. The output is a self-contained page a browser
opens directly: no build step, no framework, no server required to view
it.
"""

from __future__ import annotations

import html
import sqlite3
from dataclasses import dataclass
from typing import Any

from cairn_graph.analytics import action_summary, approval_rate, customer_overview, daily_activity, top_tools
from cairn_graph.dependencies import dependency_summary
from cairn_graph.memory import recent_history
from cairn_graph.store import stats


@dataclass(frozen=True)
class DashboardData:
    index_stats: dict[str, int]
    action_summary: dict[str, Any]
    top_tools: list[dict[str, Any]]
    daily_activity: list[dict[str, Any]]
    approval_rate: float | None
    dependency_summary: dict[str, Any]
    customers: list[dict[str, Any]]
    recent_conversation: list[dict[str, Any]]
    customer_id: str | None


def assemble_dashboard_data(
    conn: sqlite3.Connection, memory_conn: sqlite3.Connection, customer_id: str | None = None
) -> DashboardData:
    """One read-only pass over everything this service already tracks —
    no new storage, the same "compute live from existing tables" choice
    reachability.py/dependencies.py already made."""
    customers = (
        [
            {"customer_id": c.customer_id, "action_count": c.action_count, "conversation_turn_count": c.conversation_turn_count}
            for c in customer_overview(conn, memory_conn)
        ]
        if customer_id is None
        else []
    )
    history = (
        [{"role": t.role, "content": t.content} for t in recent_history(memory_conn, customer_id, limit=15)]
        if customer_id is not None
        else []
    )
    return DashboardData(
        index_stats=stats(conn),
        action_summary=action_summary(conn, customer_id),
        top_tools=top_tools(conn, customer_id),
        daily_activity=daily_activity(conn, customer_id),
        approval_rate=approval_rate(conn, customer_id),
        dependency_summary=dependency_summary(conn),
        customers=customers,
        recent_conversation=history,
        customer_id=customer_id,
    )


def _build_narrative_prompt(data: DashboardData) -> str:
    lines = [
        f"Codebase index: {data.index_stats['files']} files, {data.index_stats['symbols']} symbols, "
        f"{data.index_stats['calls']} call edges.",
    ]
    if data.dependency_summary["most_depended_on"]:
        top_files = ", ".join(row["file"].rsplit("/", 1)[-1] for row in data.dependency_summary["most_depended_on"][:5])
        lines.append(f"Most-depended-on files (highest blast radius): {top_files}.")
    if data.top_tools:
        tool_list = ", ".join(f"{r['tool_name']} ({r['count']}x)" for r in data.top_tools[:5])
        lines.append(f"Most-used agent actions: {tool_list}.")
    lines.append(f"Total agent actions taken: {data.action_summary['total_actions']}.")
    if data.approval_rate is not None:
        lines.append(f"Approval rate (actions that proceeded vs. stopped for human approval): {data.approval_rate:.0%}.")
    if data.dependency_summary["cycle_count"]:
        lines.append(f"{data.dependency_summary['cycle_count']} circular import chain(s) detected.")
    if data.recent_conversation:
        turns = "\n".join(f"  {t['role']}: {t['content']}" for t in data.recent_conversation[-10:])
        lines.append(f"Recent conversation with this customer:\n{turns}")
    return "\n".join(lines)


def generate_narrative(data: DashboardData, llm_provider: Any) -> str:
    """The "smart" part: hands the assembled real data to an LLMProvider
    and asks for a short, grounded read of what this company/software
    seems to be building and how they're actually using the agent.
    `llm_provider` is anything satisfying `providers.LLMProvider` —
    injected, not imported, so this stays testable with a deterministic
    fake and swappable to any registered provider in production."""
    prompt = _build_narrative_prompt(data)
    system = (
        "You are summarizing real usage data for a software company's engineering "
        "dashboard. Write 2-4 sentences characterizing what this codebase/company "
        "appears to be building and how they're using their AI coding agent, based "
        "strictly on the data given — never invent a fact not present in it. If the "
        "data is too sparse to say much, say that plainly instead of padding."
    )
    return llm_provider.complete(prompt, system=system)


_STATUS_GOOD = "#1c8a6e"
_STATUS_WARN = "#b8862c"


def _esc(value: Any) -> str:
    return html.escape(str(value))


def render_dashboard_html(data: DashboardData, narrative: str, title: str = "Cairn Dashboard") -> str:
    scope_label = _esc(data.customer_id or "All customers")
    approval_pct = f"{data.approval_rate:.0%}" if data.approval_rate is not None else "—"

    stat_tiles = "".join(
        f'<div class="tile"><div class="tile-value">{_esc(value)}</div><div class="tile-label">{_esc(label)}</div></div>'
        for label, value in [
            ("Files indexed", data.index_stats["files"]),
            ("Symbols", data.index_stats["symbols"]),
            ("Agent actions", data.action_summary["total_actions"]),
            ("Approval rate", approval_pct),
        ]
    )

    max_daily = max((d["count"] for d in data.daily_activity), default=1)
    activity_bars = "".join(
        f'<div class="bar-row"><span class="bar-date">{_esc(d["date"])}</span>'
        f'<div class="bar-track"><div class="bar-fill" style="width:{d["count"] / max_daily * 100:.0f}%"></div></div>'
        f'<span class="bar-count">{d["count"]}</span></div>'
        for d in data.daily_activity[-14:]
    )
    activity_section = activity_bars or '<p class="empty">No activity recorded yet.</p>'

    max_tool = max((r["count"] for r in data.top_tools), default=1)
    tool_bars = "".join(
        f'<div class="bar-row"><span class="bar-date">{_esc(r["tool_name"])}</span>'
        f'<div class="bar-track"><div class="bar-fill bar-fill-accent" style="width:{r["count"] / max_tool * 100:.0f}%"></div></div>'
        f'<span class="bar-count">{r["count"]}</span></div>'
        for r in data.top_tools[:8]
    )
    tools_section = tool_bars or '<p class="empty">No tool usage recorded yet.</p>'

    dep_rows = "".join(
        f'<tr><td>{_esc(row["file"])}</td><td class="num">{row["dependent_count"]}</td></tr>'
        for row in data.dependency_summary["most_depended_on"][:8]
    )
    dep_section = (
        f'<table class="dep-table"><thead><tr><th>File</th><th class="num">Depended on by</th></tr></thead>'
        f"<tbody>{dep_rows}</tbody></table>"
        if dep_rows
        else '<p class="empty">No internal dependencies resolved yet.</p>'
    )
    cycle_note = (
        f'<div class="status-pill status-warn">{data.dependency_summary["cycle_count"]} import cycle(s) found</div>'
        if data.dependency_summary["cycle_count"]
        else '<div class="status-pill status-good">No import cycles</div>'
    )

    customer_rows = "".join(
        f'<tr><td>{_esc(c["customer_id"])}</td><td class="num">{c["action_count"]}</td><td class="num">{c["conversation_turn_count"]}</td></tr>'
        for c in data.customers
    )
    customer_section = (
        f'<table class="dep-table"><thead><tr><th>Customer</th><th class="num">Actions</th><th class="num">Conversation turns</th></tr></thead>'
        f"<tbody>{customer_rows}</tbody></table>"
        if customer_rows
        else ""
    )

    return f"""<title>{_esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root {{
  --bg: #eef1f5; --surface: #ffffff; --border: #d7dde5; --ink: #12161d; --ink-muted: #5a6577;
  --accent: #2f6fed; --accent-soft: #dde8fd;
}}
@media (prefers-color-scheme: dark) {{
  :root:not([data-theme="light"]) {{
    --bg: #0c0f14; --surface: #141920; --border: #262e3a; --ink: #e8ecf3; --ink-muted: #8b96a8;
    --accent: #5b93ff; --accent-soft: #1c2740;
  }}
}}
:root[data-theme="dark"] {{
  --bg: #0c0f14; --surface: #141920; --border: #262e3a; --ink: #e8ecf3; --ink-muted: #8b96a8;
  --accent: #5b93ff; --accent-soft: #1c2740;
}}
* {{ box-sizing: border-box; }}
body {{
  background: var(--bg); color: var(--ink); margin: 0; padding: 2.5rem 1.5rem;
  font-family: 'Inter', -apple-system, sans-serif;
}}
.page {{ max-width: 920px; margin: 0 auto; }}
h1 {{ font-size: 1.6rem; font-weight: 700; margin: 0 0 0.25rem; letter-spacing: -0.01em; text-wrap: balance; }}
.scope {{ color: var(--ink-muted); font-size: 0.85rem; margin: 0 0 2rem; font-family: 'IBM Plex Mono', monospace; }}
.narrative {{
  background: var(--surface); border: 1px solid var(--border); border-left: 3px solid var(--accent);
  border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 2rem; font-size: 1rem; line-height: 1.65;
}}
.narrative-label {{ text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem; color: var(--accent); font-weight: 600; margin-bottom: 0.6rem; }}
.tiles {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-bottom: 1.5rem; }}
.tile {{ background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1rem; }}
.tile-value {{ font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; font-family: 'IBM Plex Mono', monospace; }}
.tile-label {{ color: var(--ink-muted); font-size: 0.78rem; margin-top: 0.25rem; }}
section {{ background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1.25rem 1.5rem; margin-bottom: 1.25rem; }}
h2 {{ font-size: 0.78rem; margin: 0 0 1rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink-muted); font-weight: 600; }}
.bar-row {{ display: grid; grid-template-columns: 110px 1fr 34px; align-items: center; gap: 0.6rem; margin-bottom: 0.45rem; font-size: 0.82rem; }}
.bar-date {{ color: var(--ink-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; }}
.bar-track {{ background: var(--accent-soft); border-radius: 4px; height: 10px; overflow: hidden; }}
.bar-fill {{ background: var(--ink-muted); height: 100%; border-radius: 4px; }}
.bar-fill-accent {{ background: var(--accent); }}
.bar-count {{ text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-muted); font-family: 'IBM Plex Mono', monospace; font-size: 0.78rem; }}
.dep-table {{ width: 100%; border-collapse: collapse; font-size: 0.85rem; }}
.dep-table th {{ text-align: left; color: var(--ink-muted); font-weight: 500; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }}
.dep-table td {{ padding: 0.45rem 0; border-bottom: 1px solid var(--border); font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem; }}
.dep-table .num {{ text-align: right; font-variant-numeric: tabular-nums; }}
.status-pill {{ display: inline-block; padding: 0.3rem 0.75rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }}
.status-good {{ background: color-mix(in srgb, {_STATUS_GOOD} 16%, transparent); color: {_STATUS_GOOD}; }}
.status-warn {{ background: color-mix(in srgb, {_STATUS_WARN} 16%, transparent); color: {_STATUS_WARN}; }}
.empty {{ color: var(--ink-muted); font-size: 0.88rem; margin: 0; }}
</style>
<div class="page">
  <h1>{_esc(title)}</h1>
  <p class="scope">{scope_label}</p>
  <div class="narrative">
    <div class="narrative-label">What the data says</div>
    {_esc(narrative)}
  </div>
  <div class="tiles">{stat_tiles}</div>
  <section>
    <h2>Daily activity</h2>
    {activity_section}
  </section>
  <section>
    <h2>Most-used tools</h2>
    {tools_section}
  </section>
  <section>
    <h2>Dependency graph</h2>
    {cycle_note}
    <div style="height:0.75rem"></div>
    {dep_section}
  </section>
  {f'<section><h2>Customers</h2>{customer_section}</section>' if customer_section else ""}
</div>
"""

"""Month 3's first slice: multi-agent coordination — the mechanism behind
pillar 2 of the platform-operator plan ("best multi-agent systems
coordination").

The graph is deliberately not a set of independent LLM-calling agents
wired together. The real-world coordination failure for this class of
system is almost never "the model wasn't smart enough" — it's scope: one
agent with every tool available eventually runs a destructive tool it had
no business touching for what was a read-only question. So this module's
actual job is routing *and* tool-scoping: decide which specialist role a
request belongs to, then hand that specialist only the MCP tool names its
role owns — a read-only request never even sees `delete_file_tool` or
`run_command_tool` as an option, not because it was told not to use them,
but because they were never in its toolset.

The routing decision itself is behind an injectable `Planner` — a plain
`(request, specialists) -> name` callable — so a real LLM-backed planner
can be swapped in later (pillar 5: configurable LLM providers) without
retesting the graph wiring. `keyword_planner` is a deterministic,
zero-dependency default, good enough to route the obvious cases and to
keep this module's tests fast and network-free.

Built on LangGraph (`StateGraph`) rather than a hand-rolled dispatch
table: the plan's grounding on LangGraph is specifically because Month 4+
(memory, longer-running sessions, human-in-the-loop interrupts) need
LangGraph's checkpointing and interrupt primitives, which a hand-rolled
router doesn't get for free. API verified live against the installed
package (1.2.11) with a real StateGraph/add_conditional_edges/compile/
invoke smoke test before writing this module, not assumed from training
data — the same discipline that caught the FastMCP rename and the
tree-sitter-language-pack download issue earlier in this project.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Sequence, TypedDict


@dataclass(frozen=True)
class Specialist:
    name: str
    description: str
    tools: tuple[str, ...]


DEFAULT_SPECIALISTS: tuple[Specialist, ...] = (
    Specialist(
        "read",
        "Answers questions about the codebase: search, usages, dead code, "
        "semantic search, stats, audit log. Never mutates anything.",
        ("search", "usages", "dead_code", "semantic", "stats_tool", "audit_log_tool", "reindex_tool", "vectorize_tool"),
    ),
    Specialist(
        "edit",
        "Makes scoped, reversible file changes — a single-file text edit "
        "or creating a new file. Never deletes or runs commands.",
        ("apply_edit_tool", "create_file_tool"),
    ),
    Specialist(
        "exec",
        "The two CRITICAL-tier actions: deleting a file or running a "
        "shell command. Always gated regardless of permission mode.",
        ("delete_file_tool", "run_command_tool"),
    ),
)

Planner = Callable[[str, Sequence[Specialist]], str]


def keyword_planner(request: str, specialists: Sequence[Specialist]) -> str:
    """The zero-dependency default: pick "exec" or "edit" by an explicit
    keyword list, else fall back to "read". Deliberately conservative in
    one direction only — an ambiguous request that could plausibly be a
    read routes to "read", never to "exec", since routing to the wrong
    read-only specialist just means a wasted round-trip, while routing an
    innocuous request to "exec" is the actual failure mode worth avoiding
    at the routing layer, before the permission gate even gets a look."""
    text = request.lower()
    if any(kw in text for kw in ("delete", "remove", "rm ", "run ", "execute", "shell command", "npm ", "pytest", "git ")):
        return "exec"
    if any(kw in text for kw in ("edit", "change", "replace", "update", "create", "write", "add a", "fix ")):
        return "edit"
    return "read"


class OrchestratorState(TypedDict):
    request: str
    specialist: str
    available_tools: list[str]


def build_orchestrator(specialists: Sequence[Specialist] = DEFAULT_SPECIALISTS, planner: Planner = keyword_planner):
    """Compiles the LangGraph StateGraph. Split out from `route_request`
    so a caller that wants to invoke the same compiled graph repeatedly
    (a real orchestrator loop) doesn't recompile it on every call."""
    from langgraph.graph import END, START, StateGraph

    by_name = {s.name: s for s in specialists}
    if len(by_name) != len(specialists):
        raise ValueError("specialist names must be unique")

    def planner_node(state: OrchestratorState) -> dict:
        chosen = planner(state["request"], specialists)
        if chosen not in by_name:
            raise ValueError(f"planner chose unknown specialist {chosen!r}; known: {sorted(by_name)}")
        return {"specialist": chosen}

    def make_specialist_node(spec: Specialist):
        def node(_state: OrchestratorState) -> dict:
            return {"available_tools": list(spec.tools)}

        return node

    def route(state: OrchestratorState) -> str:
        return state["specialist"]

    graph = StateGraph(OrchestratorState)
    graph.add_node("planner", planner_node)
    for spec in specialists:
        graph.add_node(spec.name, make_specialist_node(spec))
    graph.add_edge(START, "planner")
    graph.add_conditional_edges("planner", route, {s.name: s.name for s in specialists})
    for spec in specialists:
        graph.add_edge(spec.name, END)
    return graph.compile()


def llm_planner(provider, specialists: Sequence[Specialist] = DEFAULT_SPECIALISTS) -> Planner:
    """Wraps any `providers.LLMProvider` into a `Planner` — the real
    routing logic once a hosted LLM is registered (pillar 5), replacing
    `keyword_planner` without touching `build_orchestrator` or anything
    that calls `route_request`. Takes `provider` unannotated to avoid a
    hard import dependency from this module onto providers.py; anything
    with a matching `.complete(prompt, *, system=...)` works, structurally
    (see `providers.LLMProvider`)."""

    def planner(request: str, avail: Sequence[Specialist]) -> str:
        options = "\n".join(f"- {s.name}: {s.description}" for s in avail)
        prompt = f"Specialists:\n{options}\n\nRequest: {request}"
        reply = provider.complete(prompt, system="Route this request to exactly one specialist. Reply with only its name.")
        normalized = reply.strip().lower()
        # Word-boundary match, not bare substring: a chatty real LLM reply
        # ("I'd route this to edit") or a naive echo of the prompt (which
        # necessarily contains every candidate name in its options list)
        # can both contain more than one specialist name as a substring —
        # \b keeps "read" from matching inside some future specialist
        # named e.g. "readonly".
        for spec in avail:
            if re.search(rf"\b{re.escape(spec.name)}\b", normalized):
                return spec.name
        raise ValueError(f"LLM planner reply {reply!r} didn't match any specialist name in {[s.name for s in avail]}")

    return planner


def route_request(
    request: str,
    specialists: Sequence[Specialist] = DEFAULT_SPECIALISTS,
    planner: Planner = keyword_planner,
) -> dict:
    """Plain-function entry point: which specialist would handle this
    request, and exactly which MCP tool names it's scoped to. This is
    what an orchestrator loop calls before letting an LLM see a toolset —
    the LLM never gets `run_command_tool` in its schema for a "search for
    X" request, not just an instruction not to use it."""
    compiled = build_orchestrator(specialists, planner)
    result = compiled.invoke({"request": request, "specialist": "", "available_tools": []})
    return {"specialist": result["specialist"], "available_tools": result["available_tools"]}

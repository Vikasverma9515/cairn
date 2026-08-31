from __future__ import annotations

import pytest

from cairn_graph.orchestrator import (
    DEFAULT_SPECIALISTS,
    Specialist,
    build_orchestrator,
    keyword_planner,
    llm_planner,
    route_request,
)
from cairn_graph.providers import EchoLLMProvider


def test_keyword_planner_routes_a_search_request_to_read():
    assert keyword_planner("where is findElement defined?", DEFAULT_SPECIALISTS) == "read"


def test_keyword_planner_routes_an_edit_request_to_edit():
    assert keyword_planner("replace the greeting text in a.ts", DEFAULT_SPECIALISTS) == "edit"


def test_keyword_planner_routes_a_destructive_request_to_exec():
    assert keyword_planner("delete the old config file", DEFAULT_SPECIALISTS) == "exec"


def test_keyword_planner_routes_a_shell_request_to_exec():
    assert keyword_planner("run npm test", DEFAULT_SPECIALISTS) == "exec"


def test_ambiguous_request_defaults_to_read_not_exec():
    # The one direction the planner is deliberately conservative in: an
    # unclear request should never land on the specialist holding the
    # CRITICAL-tier tools.
    assert keyword_planner("tell me about this codebase", DEFAULT_SPECIALISTS) == "read"


def test_route_request_scopes_tools_to_only_the_chosen_specialist():
    result = route_request("find every usage of resolveVerb")

    assert result["specialist"] == "read"
    assert "search" in result["available_tools"]
    assert "run_command_tool" not in result["available_tools"]
    assert "delete_file_tool" not in result["available_tools"]


def test_route_request_for_a_destructive_request_only_exposes_exec_tools():
    result = route_request("delete the unused scratch.ts file")

    assert result["specialist"] == "exec"
    assert set(result["available_tools"]) == {"delete_file_tool", "run_command_tool"}
    assert "search" not in result["available_tools"]


def test_route_request_accepts_a_custom_planner():
    def always_edit(request: str, specialists) -> str:
        return "edit"

    result = route_request("anything at all", planner=always_edit)

    assert result["specialist"] == "edit"


def test_build_orchestrator_rejects_duplicate_specialist_names():
    dupes = (
        Specialist("read", "a", ("x",)),
        Specialist("read", "b", ("y",)),
    )
    with pytest.raises(ValueError):
        build_orchestrator(dupes)


def test_build_orchestrator_raises_on_a_planner_returning_an_unknown_specialist():
    def broken_planner(request: str, specialists) -> str:
        return "not-a-real-specialist"

    compiled = build_orchestrator(planner=broken_planner)
    with pytest.raises(ValueError):
        compiled.invoke({"request": "x", "specialist": "", "available_tools": []})


class _FakeLLMProvider:
    """Deterministic stand-in — returns a canned reply regardless of the
    prompt, so the test exercises llm_planner's parsing/validation logic
    without depending on any real model's actual judgment."""

    def __init__(self, reply: str):
        self._reply = reply

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        return self._reply


def test_llm_planner_routes_using_the_providers_reply():
    planner = llm_planner(_FakeLLMProvider("edit"))
    assert planner("anything", DEFAULT_SPECIALISTS) == "edit"


def test_llm_planner_normalizes_case_and_surrounding_text():
    planner = llm_planner(_FakeLLMProvider("  I'd pick EXEC for this one.  "))
    assert planner("anything", DEFAULT_SPECIALISTS) == "exec"


def test_llm_planner_raises_a_clear_error_when_the_reply_matches_nothing():
    planner = llm_planner(_FakeLLMProvider("banana"))
    with pytest.raises(ValueError, match="banana"):
        planner("anything", DEFAULT_SPECIALISTS)


def test_llm_planner_runs_end_to_end_against_the_real_echo_provider_without_crashing():
    # EchoLLMProvider echoes the whole prompt back — which necessarily
    # contains every specialist name, since they're listed in the prompt
    # itself — so this can't prove llm_planner picks the *right*
    # specialist (that needs a real model's judgment, not a stand-in).
    # It does prove the provider -> planner -> route_request plumbing
    # runs end to end without a type error or an unhandled exception,
    # which is the actual thing worth verifying without a live LLM.
    result = route_request("anything", planner=llm_planner(EchoLLMProvider()))
    assert result["specialist"] in {s.name for s in DEFAULT_SPECIALISTS}


def test_route_request_accepts_an_llm_planner_via_build_orchestrator():
    result = route_request("anything", planner=llm_planner(_FakeLLMProvider("read")))
    assert result["specialist"] == "read"


def test_custom_specialist_set_is_honored():
    custom = (Specialist("only_one", "everything", ("a", "b", "c")),)

    def always_only_one(request: str, specialists) -> str:
        return "only_one"

    result = route_request("anything", specialists=custom, planner=always_only_one)

    assert result["specialist"] == "only_one"
    assert set(result["available_tools"]) == {"a", "b", "c"}

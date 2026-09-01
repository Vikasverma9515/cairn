from __future__ import annotations

import json

import pytest

from cairn_graph.agent_loop import MissingCredentialError, ToolSpec, run_agent_loop


class _FakeFunction:
    def __init__(self, name: str, arguments: dict):
        self.name = name
        self.arguments = json.dumps(arguments)


class _FakeToolCall:
    def __init__(self, call_id: str, name: str, arguments: dict):
        self.id = call_id
        self.function = _FakeFunction(name, arguments)
        self.type = "function"

    def model_dump(self) -> dict:
        return {"id": self.id, "type": self.type, "function": {"name": self.function.name, "arguments": self.function.arguments}}


class _FakeMessage:
    def __init__(self, content: str | None = None, tool_calls: list | None = None):
        self.content = content
        self.tool_calls = tool_calls or []


class _FakeChoice:
    def __init__(self, message: _FakeMessage):
        self.message = message


class _FakeResponse:
    def __init__(self, message: _FakeMessage):
        self.choices = [_FakeChoice(message)]


class _ScriptedClient:
    """A fake Groq client — .chat.completions.create returns the next
    scripted response each call, and records every call's tool_choice so
    tests can verify the repeat-call defense actually fires."""

    def __init__(self, responses: list[_FakeMessage]):
        self._responses = list(responses)
        self.calls: list[dict] = []
        self.chat = self

    @property
    def completions(self):
        return self

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = self._responses.pop(0)
        return _FakeResponse(message)


def _search_tool(results: dict) -> ToolSpec:
    return ToolSpec(
        name="search_symbols",
        description="Search the codebase for a symbol by name.",
        parameters={"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        fn=lambda query: results.get(query, {"matches": []}),
    )


def test_answers_directly_when_the_model_calls_no_tool():
    client = _ScriptedClient([_FakeMessage(content="Hi there!")])

    result = run_agent_loop("hello", tools=[], client=client)

    assert result.final_text == "Hi there!"
    assert result.tool_calls_made == []
    assert result.iterations_used == 1
    assert result.gave_up is False


def test_executes_a_real_tool_call_and_returns_the_final_answer():
    tool = _search_tool({"highlight": {"name": "highlightElement", "file": "element-ladder.ts"}})
    client = _ScriptedClient(
        [
            _FakeMessage(content="Let me search.", tool_calls=[_FakeToolCall("call-1", "search_symbols", {"query": "highlight"})]),
            _FakeMessage(content="It's highlightElement in element-ladder.ts."),
        ]
    )

    result = run_agent_loop("find the highlight function", tools=[tool], client=client)

    assert result.final_text == "It's highlightElement in element-ladder.ts."
    assert len(result.tool_calls_made) == 1
    assert result.tool_calls_made[0].name == "search_symbols"
    assert result.tool_calls_made[0].arguments == {"query": "highlight"}
    assert result.tool_calls_made[0].result == {"name": "highlightElement", "file": "element-ladder.ts"}
    assert result.iterations_used == 2


def test_the_tool_result_is_fed_back_as_a_real_tool_message():
    tool = _search_tool({"highlight": {"name": "highlightElement"}})
    client = _ScriptedClient(
        [
            _FakeMessage(tool_calls=[_FakeToolCall("call-1", "search_symbols", {"query": "highlight"})]),
            _FakeMessage(content="done"),
        ]
    )

    run_agent_loop("find it", tools=[tool], client=client)

    second_call_messages = client.calls[1]["messages"]
    tool_messages = [m for m in second_call_messages if m["role"] == "tool"]
    assert len(tool_messages) == 1
    assert tool_messages[0]["tool_call_id"] == "call-1"
    assert json.loads(tool_messages[0]["content"]) == {"name": "highlightElement"}


def test_repeated_identical_tool_call_forces_tool_choice_none_on_the_next_call():
    # Regression test for the real bug found live against the real Groq
    # account: the model can re-call the same (name, arguments) pair
    # instead of recognizing the tool result it was just given. The
    # defense is forcing tool_choice="none" once that repeat is detected
    # — verified here by checking the actual kwarg sent on the call right
    # after the repeat, not just that the loop eventually terminates.
    tool = _search_tool({"highlight": {"name": "highlightElement"}})
    same_call = _FakeToolCall("call-1", "search_symbols", {"query": "highlight"})
    same_call_again = _FakeToolCall("call-2", "search_symbols", {"query": "highlight"})
    client = _ScriptedClient(
        [
            _FakeMessage(tool_calls=[same_call]),
            _FakeMessage(tool_calls=[same_call_again]),  # the model repeats itself
            _FakeMessage(content="It's highlightElement."),
        ]
    )

    result = run_agent_loop("find it", tools=[tool], client=client)

    assert result.final_text == "It's highlightElement."
    assert client.calls[0]["tool_choice"] == "auto"
    assert client.calls[1]["tool_choice"] == "auto"  # the repeat itself is only detected once it happens
    assert client.calls[2]["tool_choice"] == "none"  # forced after the repeat


def test_gives_up_honestly_after_max_iterations_instead_of_looping_forever():
    tool = _search_tool({})
    # A client that always wants to call a *different* tool query each
    # time (never repeating), so the repeat-call defense never fires —
    # proves max_iterations is a real, independent safety net, not the
    # only thing standing between this and an infinite loop.
    responses = [_FakeMessage(tool_calls=[_FakeToolCall(f"call-{i}", "search_symbols", {"query": f"q{i}"})]) for i in range(10)]
    client = _ScriptedClient(responses)

    result = run_agent_loop("find it", tools=[tool], client=client, max_iterations=3)

    assert result.gave_up is True
    assert result.final_text is None
    assert result.iterations_used == 3
    assert len(result.tool_calls_made) == 3


def test_a_tool_that_raises_feeds_an_error_back_instead_of_crashing_the_loop():
    def boom(query: str):
        raise ValueError("simulated failure")

    tool = ToolSpec(name="broken_tool", description="always fails", parameters={"type": "object", "properties": {"query": {"type": "string"}}}, fn=boom)
    client = _ScriptedClient(
        [
            _FakeMessage(tool_calls=[_FakeToolCall("call-1", "broken_tool", {"query": "x"})]),
            _FakeMessage(content="Something went wrong."),
        ]
    )

    result = run_agent_loop("do it", tools=[tool], client=client)

    assert result.final_text == "Something went wrong."
    assert "ValueError" in result.tool_calls_made[0].result["error"]


def test_a_call_to_an_unknown_tool_name_feeds_a_clear_error_back():
    client = _ScriptedClient(
        [
            _FakeMessage(tool_calls=[_FakeToolCall("call-1", "nonexistent_tool", {})]),
            _FakeMessage(content="I couldn't find that tool."),
        ]
    )

    result = run_agent_loop("do it", tools=[], client=client)

    assert result.tool_calls_made[0].result == {"error": "no such tool: nonexistent_tool"}


def test_missing_credential_raises_a_clear_error_with_no_client_and_no_key(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(MissingCredentialError, match="GROQ_API_KEY"):
        run_agent_loop("hello", tools=[])


def test_system_prompt_is_included_as_the_first_message_when_given():
    client = _ScriptedClient([_FakeMessage(content="ok")])

    run_agent_loop("hello", tools=[], client=client, system="You are terse.")

    assert client.calls[0]["messages"][0] == {"role": "system", "content": "You are terse."}

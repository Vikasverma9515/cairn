"""Real tool-calling agent loop — Month 9's actual foundation. Gives an
LLM real tools to call and executes them, closing the gap
`voice_pipeline.py` found live: a reply that's genuinely good but never
executes anything, just talks about what it would do.

Not built against `providers.LLMProvider` — plain text completion
(`complete(prompt, *, system=None) -> str`) is the wrong shape for
tool-calling (no way to hand back a structured tool-call decision through
a bare string). This talks to the real Groq SDK's tool-calling API
directly instead, the only LLM provider currently behaviorally verified
in this project — the same "don't force one interface to do two
different jobs" principle as everything else here.

**A real bug found live, not assumed, with a real fix**: a real
multi-turn tool-calling round trip against this project's actual Groq
account — message schema confirmed correct against Groq's own type
definitions (`ChatCompletionToolMessageParam`,
`ChatCompletionAssistantMessageParam`) before suspecting anything else —
still had the model re-call the *same* tool with the *same* arguments
instead of recognizing the tool result it was just handed and answering.
Confirmed this wasn't a one-model quirk: two different real models
(`openai/gpt-oss-120b` and `qwen/qwen3.8-27b`) both did it. Confirmed the
fix live: forcing `tool_choice="none"` once a repeated (name, arguments)
call is detected reliably produces a real, correct final answer using
the tool result already gathered. A max-iteration cap alone isn't a
sufficient safeguard against this — it would just burn the whole budget
re-asking the same question — so repeat-call detection is the actual
defense, tested directly below.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Callable

DEFAULT_MODEL = "qwen/qwen3.8-27b"


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    parameters: dict  # JSON Schema, per Groq/OpenAI's function-calling convention
    fn: Callable[..., Any]  # called as fn(**parsed_arguments); its return value is JSON-encoded back to the model

    def to_groq_tool(self) -> dict:
        return {"type": "function", "function": {"name": self.name, "description": self.description, "parameters": self.parameters}}


@dataclass
class ToolCallRecord:
    name: str
    arguments: dict
    result: Any


@dataclass
class AgentLoopResult:
    final_text: str | None
    tool_calls_made: list[ToolCallRecord] = field(default_factory=list)
    iterations_used: int = 0
    gave_up: bool = False  # hit max_iterations without a final text answer


class MissingCredentialError(RuntimeError):
    pass


def _build_client(api_key: str | None):
    import os

    key = api_key or os.environ.get("GROQ_API_KEY")
    if not key:
        raise MissingCredentialError("run_agent_loop needs a Groq API key: pass api_key= or set GROQ_API_KEY")
    from groq import Groq

    return Groq(api_key=key)


def run_agent_loop(
    request: str,
    tools: list[ToolSpec],
    *,
    system: str | None = None,
    api_key: str | None = None,
    model: str = DEFAULT_MODEL,
    max_iterations: int = 6,
    max_tokens: int = 500,
    client: Any = None,
) -> AgentLoopResult:
    """Runs one request through a real tool-calling loop until the model
    gives a final text answer, calls the same (name, arguments) pair
    twice (at which point the next call is forced to stop calling tools
    — see this module's docstring for why that specific defense exists),
    or `max_iterations` is exhausted.

    `client` is injected for tests — anything with a `.chat.completions.
    create(model=, messages=, tools=, tool_choice=, max_completion_tokens=)`
    method matching Groq's real shape works, so the automated suite runs
    a scripted fake and never needs a network call or credential; a real
    `Groq(...)` client is built from `api_key`/`GROQ_API_KEY` when none
    is given."""
    groq_client = client if client is not None else _build_client(api_key)
    groq_tools = [t.to_groq_tool() for t in tools]
    tools_by_name = {t.name: t for t in tools}

    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": request})

    seen_calls: set[tuple[str, str]] = set()
    tool_calls_made: list[ToolCallRecord] = []
    force_stop = False

    for iteration in range(1, max_iterations + 1):
        response = groq_client.chat.completions.create(
            model=model,
            messages=messages,
            tools=groq_tools,
            tool_choice="none" if force_stop else "auto",
            max_completion_tokens=max_tokens,
        )
        message = response.choices[0].message

        if not message.tool_calls:
            return AgentLoopResult(final_text=message.content, tool_calls_made=tool_calls_made, iterations_used=iteration)

        messages.append({"role": "assistant", "content": message.content, "tool_calls": [tc.model_dump() for tc in message.tool_calls]})

        for tc in message.tool_calls:
            raw_args = tc.function.arguments
            key = (tc.function.name, raw_args)
            if key in seen_calls:
                force_stop = True  # the repeat-call defense — see module docstring
            seen_calls.add(key)

            spec = tools_by_name.get(tc.function.name)
            if spec is None:
                result: Any = {"error": f"no such tool: {tc.function.name}"}
            else:
                try:
                    parsed_args = json.loads(raw_args) if raw_args else {}
                    result = spec.fn(**parsed_args)
                except Exception as exc:  # noqa: BLE001 — a tool failing must feed back into the loop, not crash it
                    result = {"error": f"{type(exc).__name__}: {exc}"}

            tool_calls_made.append(ToolCallRecord(name=tc.function.name, arguments=json.loads(raw_args) if raw_args else {}, result=result))
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps(result, default=str)})

    return AgentLoopResult(final_text=None, tool_calls_made=tool_calls_made, iterations_used=max_iterations, gave_up=True)

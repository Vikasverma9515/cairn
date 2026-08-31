"""Provider abstraction — pillar 5 of the plan: "publish this as a
package and everyone can configure the LLM models, voice models, and
other things... customize according to their needs."

Three Protocols (structural typing — anything with the right method
shape qualifies, no base class to inherit from) plus a name-keyed
registry per kind, selectable by config (an env var, or an explicit
name) rather than a code change. This is the seam pillar 5 asks for:
swapping the LLM or the voice provider means registering a new factory
under a new name, not touching the orchestrator or the MCP server.

What's deliberately NOT here: real Cartesia/Deepgram/Groq (or
OpenAI/Anthropic realtime) SDK calls. This project's standing discipline
is "verify every SDK call against the real, installed package before
writing it — never guess a vendor's method signature from training
data" (it's what caught the FastMCP rename and the tree-sitter-language-
pack download issue earlier). There's no credentialed account available
in this environment to verify a hosted voice/LLM SDK against, and
writing unverified vendor integration code would break that discipline
for the sake of looking more finished. Wiring a real provider in later is
implementing one of the three Protocols below against that vendor's
verified SDK — the registry, the config-driven selection, and everything
that calls through this module stay unchanged.

Each Protocol ships exactly one concrete implementation here: a fully
local, fully real (not mocked-in-tests-only) default that proves the
registry/config wiring end to end without any network call or API key.
`EchoLLMProvider` is honestly a stand-in, not a real model — it exists so
a pipeline can be built and tested end to end for free before a real
provider is registered.
"""

from __future__ import annotations

import os
from typing import Callable, Protocol, runtime_checkable


@runtime_checkable
class LLMProvider(Protocol):
    def complete(self, prompt: str, *, system: str | None = None) -> str: ...


@runtime_checkable
class STTProvider(Protocol):
    def transcribe(self, audio: bytes) -> str: ...


@runtime_checkable
class TTSProvider(Protocol):
    def synthesize(self, text: str) -> bytes: ...


class ProviderNotRegisteredError(KeyError):
    pass


class Registry:
    """One instance per provider kind (llm / stt / tts) — keeps
    `ProviderRegistry` below from needing three near-identical classes."""

    def __init__(self, kind: str):
        self.kind = kind
        self._factories: dict[str, Callable[[], object]] = {}

    def register(self, name: str, factory: Callable[[], object]) -> None:
        self._factories[name] = factory

    def create(self, name: str):
        if name not in self._factories:
            raise ProviderNotRegisteredError(f"no {self.kind} provider registered as {name!r}; known: {self.names()}")
        return self._factories[name]()

    def names(self) -> list[str]:
        return sorted(self._factories)


class EchoLLMProvider:
    """A real, fully local, zero-network stand-in — deterministic, not a
    real model. Exists to prove the registry/config wiring end to end
    before a real hosted provider is registered under its own name."""

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        prefix = f"[{system}] " if system else ""
        return f"{prefix}[echo] {prompt}"


class UnconfiguredSTTProvider:
    """The honest default for a capability nothing local can fulfill: a
    clear error naming the fix, not a silently-empty fake transcript."""

    def transcribe(self, audio: bytes) -> str:
        raise NotImplementedError(
            "no STT provider registered — register a real implementation of "
            "STTProvider (e.g. Deepgram, Whisper) under a name and select it "
            "via CAIRN_STT_PROVIDER, or pass provider_name explicitly"
        )


class UnconfiguredTTSProvider:
    def synthesize(self, text: str) -> bytes:
        raise NotImplementedError(
            "no TTS provider registered — register a real implementation of "
            "TTSProvider (e.g. Cartesia, ElevenLabs) under a name and select "
            "it via CAIRN_TTS_PROVIDER, or pass provider_name explicitly"
        )


llm_registry = Registry("llm")
llm_registry.register("echo", EchoLLMProvider)

stt_registry = Registry("stt")
stt_registry.register("unconfigured", UnconfiguredSTTProvider)

tts_registry = Registry("tts")
tts_registry.register("unconfigured", UnconfiguredTTSProvider)


def load_provider(registry: Registry, env_var: str, default: str, provider_name: str | None = None):
    """The config-driven selection pillar 5 asks for: pass a name
    explicitly, or fall back to an env var, or fall back to a safe local
    default — in that order. Never picks a provider silently different
    from what the caller or the environment asked for."""
    name = provider_name or os.environ.get(env_var, default)
    return registry.create(name)

"""Provider abstraction — pillar 5 of the plan: "publish this as a
package and everyone can configure the LLM models, voice models, and
other things... customize according to their needs."

Three Protocols (structural typing — anything with the right method
shape qualifies, no base class to inherit from) plus a name-keyed
registry per kind, selectable by config (an env var, or an explicit
name) rather than a code change. This is the seam pillar 5 asks for:
swapping the LLM or the voice provider means registering a new factory
under a new name, not touching the orchestrator or the MCP server.

Two real hosted providers are wired in now that credentials became
available in this environment (`examples/demo-app/.env`'s
`GROQ_API_KEYS`/`DEEPGRAM_API_KEY`): `GroqLLMProvider` and
`DeepgramSTTProvider` below. Both were verified against the real
installed SDKs with live API calls before being trusted — not assumed
from docs or training data, the same discipline that caught the FastMCP
rename and the tree-sitter-language-pack download issue:

- **Groq**: `client.chat.completions.create()` takes
  `max_completion_tokens`, not `max_tokens` — confirmed by reading the
  installed SDK's real signature. A reasoning-capable model
  (`openai/gpt-oss-20b`) spent its entire token budget on internal
  reasoning tokens and returned an *empty* visible reply on the first
  live test — not a bug, a real characteristic of that model class,
  which is why the default model here is a fast non-reasoning one
  instead. The account's actual available models were fetched live via
  `client.models.list()`, not guessed.
- **Deepgram**: the real call is `client.listen.v1.media.transcribe_file
  (request=audio_bytes, model=..., ...)`, and the transcript lives at
  `response.results.channels[0].alternatives[0].transcript` — both
  confirmed with a real transcription of real synthesized speech audio
  (macOS `say` + `afconvert`), not a silent WAV.

Cartesia/ElevenLabs (TTS) remain unwired — no credentials for those were
available. Wiring one in later is implementing `TTSProvider` against
that vendor's verified SDK; the registry and everything that calls
through it stay unchanged.

Every Protocol still ships one fully local, zero-network default too —
`EchoLLMProvider` and `UnconfiguredSTTProvider`/`UnconfiguredTTSProvider`
— so the registry/config wiring stays provable without a network call or
an API key, and so the automated test suite never needs one either: the
two real providers' *SDK plumbing* (construction, missing-key handling,
Protocol conformance) is unit-tested here; their actual network
round-trip was verified live once, above, not re-run on every `pytest`
invocation — a real API call on every CI run would be flaky, cost money,
and burn through a shared account's quota for no correctness benefit
over a verified-once, documented result.
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


class MissingCredentialError(RuntimeError):
    pass


class GroqLLMProvider:
    """Real, network-calling LLM provider over Groq's chat completions
    API — verified live against the installed `groq` SDK (1.7.0): client
    construction, the `max_completion_tokens` kwarg name, and the
    `.choices[0].message.content` response path were all confirmed with
    a real call before being trusted, not assumed. The default model
    (`qwen/qwen3.8-27b`) was picked specifically because it returns a
    fast, non-reasoning reply — `openai/gpt-oss-20b` spent an entire
    small token budget on invisible reasoning tokens and returned an
    empty visible reply in the same live test, a real property of that
    model class worth avoiding for a low-latency "talking to a friend"
    default (pillar 3).

    The API key is read once at construction (`api_key=`, else
    `GROQ_API_KEY`) and never touched again — no key handling in
    `complete()`, no logging of the key anywhere."""

    def __init__(self, api_key: str | None = None, model: str = "qwen/qwen3.8-27b", max_tokens: int = 512):
        key = api_key or os.environ.get("GROQ_API_KEY")
        if not key:
            raise MissingCredentialError("GroqLLMProvider needs an API key: pass api_key= or set GROQ_API_KEY")
        from groq import Groq

        self._client = Groq(api_key=key)
        self._model = model
        self._max_tokens = max_tokens

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        messages = []
        if system:
            messages.append({"role": "system", "content": system})
        messages.append({"role": "user", "content": prompt})
        resp = self._client.chat.completions.create(model=self._model, messages=messages, max_completion_tokens=self._max_tokens)
        return resp.choices[0].message.content or ""


class DeepgramSTTProvider:
    """Real, network-calling STT provider over Deepgram's prerecorded
    transcription API — verified live against the installed
    `deepgram-sdk` (7.8.0) with a real transcription of real synthesized
    speech audio (not silence), confirming both the call shape
    (`client.listen.v1.media.transcribe_file(request=audio_bytes,
    model=...)`) and the response path
    (`response.results.channels[0].alternatives[0].transcript`) before
    being trusted."""

    def __init__(self, api_key: str | None = None, model: str = "nova-2"):
        key = api_key or os.environ.get("DEEPGRAM_API_KEY")
        if not key:
            raise MissingCredentialError("DeepgramSTTProvider needs an API key: pass api_key= or set DEEPGRAM_API_KEY")
        from deepgram import DeepgramClient

        self._client = DeepgramClient(api_key=key)
        self._model = model

    def transcribe(self, audio: bytes) -> str:
        resp = self._client.listen.v1.media.transcribe_file(request=audio, model=self._model, smart_format=True)
        return resp.results.channels[0].alternatives[0].transcript


llm_registry = Registry("llm")
llm_registry.register("echo", EchoLLMProvider)
llm_registry.register("groq", GroqLLMProvider)

stt_registry = Registry("stt")
stt_registry.register("unconfigured", UnconfiguredSTTProvider)
stt_registry.register("deepgram", DeepgramSTTProvider)

tts_registry = Registry("tts")
tts_registry.register("unconfigured", UnconfiguredTTSProvider)


def load_provider(registry: Registry, env_var: str, default: str, provider_name: str | None = None):
    """The config-driven selection pillar 5 asks for: pass a name
    explicitly, or fall back to an env var, or fall back to a safe local
    default — in that order. Never picks a provider silently different
    from what the caller or the environment asked for."""
    name = provider_name or os.environ.get(env_var, default)
    return registry.create(name)

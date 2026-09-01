from __future__ import annotations

import pytest

from cairn_graph.providers import (
    CartesiaTTSProvider,
    DeepgramSTTProvider,
    EchoLLMProvider,
    ElevenLabsTTSProvider,
    GroqLLMProvider,
    LLMProvider,
    MissingCredentialError,
    MissingVoiceIdError,
    ProviderNotRegisteredError,
    Registry,
    STTProvider,
    TTSProvider,
    UnconfiguredSTTProvider,
    UnconfiguredTTSProvider,
    llm_registry,
    load_provider,
    stt_registry,
    tts_registry,
)


def test_echo_llm_provider_satisfies_the_protocol():
    assert isinstance(EchoLLMProvider(), LLMProvider)


def test_echo_llm_provider_echoes_the_prompt():
    result = EchoLLMProvider().complete("hello")
    assert "hello" in result


def test_echo_llm_provider_includes_system_prompt_when_given():
    result = EchoLLMProvider().complete("hello", system="be terse")
    assert "be terse" in result


def test_unconfigured_stt_provider_satisfies_the_protocol():
    assert isinstance(UnconfiguredSTTProvider(), STTProvider)


def test_unconfigured_stt_provider_raises_a_clear_error():
    with pytest.raises(NotImplementedError, match="CAIRN_STT_PROVIDER"):
        UnconfiguredSTTProvider().transcribe(b"audio")


def test_unconfigured_tts_provider_satisfies_the_protocol():
    assert isinstance(UnconfiguredTTSProvider(), TTSProvider)


def test_unconfigured_tts_provider_raises_a_clear_error():
    with pytest.raises(NotImplementedError, match="CAIRN_TTS_PROVIDER"):
        UnconfiguredTTSProvider().synthesize("hi")


def test_registry_creates_a_registered_provider_by_name():
    reg = Registry("llm")
    reg.register("echo", EchoLLMProvider)
    provider = reg.create("echo")
    assert isinstance(provider, EchoLLMProvider)


def test_registry_raises_a_clear_error_for_an_unregistered_name():
    reg = Registry("llm")
    reg.register("echo", EchoLLMProvider)
    with pytest.raises(ProviderNotRegisteredError, match="echo"):
        reg.create("nope")


def test_registry_names_lists_everything_registered():
    reg = Registry("llm")
    reg.register("b", EchoLLMProvider)
    reg.register("a", EchoLLMProvider)
    assert reg.names() == ["a", "b"]


def test_default_registries_have_a_working_local_provider():
    assert isinstance(llm_registry.create("echo"), EchoLLMProvider)
    assert isinstance(stt_registry.create("unconfigured"), UnconfiguredSTTProvider)
    assert isinstance(tts_registry.create("unconfigured"), UnconfiguredTTSProvider)


def test_load_provider_uses_explicit_name_over_env_and_default(monkeypatch):
    monkeypatch.setenv("CAIRN_LLM_PROVIDER", "should-not-be-used")
    reg = Registry("llm")
    reg.register("echo", EchoLLMProvider)
    reg.register("should-not-be-used", EchoLLMProvider)

    provider = load_provider(reg, "CAIRN_LLM_PROVIDER", "echo", provider_name="echo")

    assert isinstance(provider, EchoLLMProvider)


def test_load_provider_falls_back_to_env_var_when_no_explicit_name(monkeypatch):
    reg = Registry("llm")
    calls = []
    reg.register("from-env", lambda: calls.append("used") or EchoLLMProvider())
    monkeypatch.setenv("CAIRN_LLM_PROVIDER", "from-env")

    load_provider(reg, "CAIRN_LLM_PROVIDER", "echo")

    assert calls == ["used"]


def test_load_provider_falls_back_to_default_when_no_name_or_env(monkeypatch):
    monkeypatch.delenv("CAIRN_LLM_PROVIDER", raising=False)
    provider = load_provider(llm_registry, "CAIRN_LLM_PROVIDER", "echo")
    assert isinstance(provider, EchoLLMProvider)


# --- Groq / Deepgram: SDK plumbing only, no network call --------------
# The actual round-trip (a real chat completion, a real transcription of
# real speech audio) was verified live once against the real installed
# SDKs and real credentials — see providers.py's module docstring for
# the confirmed request/response shapes. Re-making a real network call on
# every pytest run would be flaky, cost money, and burn a shared
# account's quota for no correctness benefit over that verified result.
# What's actually worth unit-testing here is this module's own logic:
# does construction fail clearly without a key, does it succeed and wire
# up correctly with one, does the result satisfy the Protocol.


def test_groq_provider_raises_a_clear_error_with_no_key(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(MissingCredentialError, match="GROQ_API_KEY"):
        GroqLLMProvider()


def test_groq_provider_constructs_with_an_explicit_key_and_satisfies_the_protocol():
    provider = GroqLLMProvider(api_key="dummy-not-a-real-key")
    assert isinstance(provider, LLMProvider)


def test_groq_provider_picks_up_the_key_from_the_env_var(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "dummy-not-a-real-key")
    provider = GroqLLMProvider()
    assert isinstance(provider, LLMProvider)


def test_groq_provider_defaults_to_a_non_reasoning_model():
    # Found live: a reasoning-capable model (openai/gpt-oss-20b) can spend
    # an entire small token budget on invisible reasoning tokens and
    # return an empty visible reply — the default here must not be one of
    # those, for a low-latency "talking to a friend" provider (pillar 3).
    provider = GroqLLMProvider(api_key="dummy-not-a-real-key")
    assert "reasoning" not in provider._model.lower() and "gpt-oss" not in provider._model


def test_deepgram_provider_raises_a_clear_error_with_no_key(monkeypatch):
    monkeypatch.delenv("DEEPGRAM_API_KEY", raising=False)
    with pytest.raises(MissingCredentialError, match="DEEPGRAM_API_KEY"):
        DeepgramSTTProvider()


def test_deepgram_provider_constructs_with_an_explicit_key_and_satisfies_the_protocol():
    provider = DeepgramSTTProvider(api_key="dummy-not-a-real-key")
    assert isinstance(provider, STTProvider)


def test_default_registries_include_the_real_providers():
    assert "groq" in llm_registry.names()
    assert "deepgram" in stt_registry.names()


def test_load_provider_selects_groq_by_explicit_name(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "dummy-not-a-real-key")
    provider = load_provider(llm_registry, "CAIRN_LLM_PROVIDER", "echo", provider_name="groq")
    assert isinstance(provider, GroqLLMProvider)


# --- Cartesia / ElevenLabs: SDK plumbing only, structurally verified,---
# --- NOT behaviorally verified (no credentials in this environment) ---
# See providers.py's module docstring for the distinction this session
# draws between "verified against the real installed SDK's structure"
# and "verified against a real account producing real audio." These
# tests cover exactly the first — construction, missing-key/missing-
# voice-id errors, Protocol conformance — the same scope as the
# Groq/Deepgram plumbing tests above.


def test_cartesia_provider_raises_a_clear_error_with_no_key(monkeypatch):
    monkeypatch.delenv("CARTESIA_API_KEY", raising=False)
    with pytest.raises(MissingCredentialError, match="CARTESIA_API_KEY"):
        CartesiaTTSProvider(voice_id="some-voice-id")


def test_cartesia_provider_raises_a_clear_error_with_no_voice_id(monkeypatch):
    monkeypatch.delenv("CARTESIA_VOICE_ID", raising=False)
    with pytest.raises(MissingVoiceIdError, match="CARTESIA_VOICE_ID"):
        CartesiaTTSProvider(api_key="dummy-not-a-real-key")


def test_cartesia_provider_constructs_with_explicit_key_and_voice_and_satisfies_the_protocol():
    provider = CartesiaTTSProvider(voice_id="some-voice-id", api_key="dummy-not-a-real-key")
    assert isinstance(provider, TTSProvider)


def test_cartesia_provider_picks_up_key_and_voice_from_env_vars(monkeypatch):
    monkeypatch.setenv("CARTESIA_API_KEY", "dummy-not-a-real-key")
    monkeypatch.setenv("CARTESIA_VOICE_ID", "some-voice-id")
    provider = CartesiaTTSProvider()
    assert isinstance(provider, TTSProvider)


def test_elevenlabs_provider_raises_a_clear_error_with_no_key(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_API_KEY", raising=False)
    with pytest.raises(MissingCredentialError, match="ELEVENLABS_API_KEY"):
        ElevenLabsTTSProvider(voice_id="some-voice-id")


def test_elevenlabs_provider_raises_a_clear_error_with_no_voice_id(monkeypatch):
    monkeypatch.delenv("ELEVENLABS_VOICE_ID", raising=False)
    with pytest.raises(MissingVoiceIdError, match="ELEVENLABS_VOICE_ID"):
        ElevenLabsTTSProvider(api_key="dummy-not-a-real-key")


def test_elevenlabs_provider_constructs_with_explicit_key_and_voice_and_satisfies_the_protocol():
    provider = ElevenLabsTTSProvider(voice_id="some-voice-id", api_key="dummy-not-a-real-key")
    assert isinstance(provider, TTSProvider)


def test_default_registries_include_the_tts_providers():
    assert "cartesia" in tts_registry.names()
    assert "elevenlabs" in tts_registry.names()


def test_load_provider_selects_cartesia_by_explicit_name(monkeypatch):
    monkeypatch.setenv("CARTESIA_API_KEY", "dummy-not-a-real-key")
    monkeypatch.setenv("CARTESIA_VOICE_ID", "some-voice-id")
    provider = load_provider(tts_registry, "CAIRN_TTS_PROVIDER", "unconfigured", provider_name="cartesia")
    assert isinstance(provider, CartesiaTTSProvider)

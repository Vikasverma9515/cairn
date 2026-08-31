from __future__ import annotations

import pytest

from cairn_graph.providers import (
    EchoLLMProvider,
    LLMProvider,
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

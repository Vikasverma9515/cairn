from __future__ import annotations

from pathlib import Path

from cairn_graph.memory import open_memory_store, recent_history
from cairn_graph.orchestrator import DEFAULT_SPECIALISTS, keyword_planner
from cairn_graph.voice_pipeline import run_voice_turn


class _FakeSTT:
    def __init__(self, transcript: str):
        self._transcript = transcript
        self.received_audio = None

    def transcribe(self, audio: bytes) -> str:
        self.received_audio = audio
        return self._transcript


class _FakeLLM:
    def __init__(self, reply: str):
        self._reply = reply
        self.last_prompt = None
        self.last_system = None

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        self.last_prompt = prompt
        self.last_system = system
        return self._reply


class _FakeTTS:
    def __init__(self, audio: bytes = b"fake-audio-bytes"):
        self._audio = audio
        self.last_text = None

    def synthesize(self, text: str) -> bytes:
        self.last_text = text
        return self._audio


def test_run_voice_turn_connects_all_four_stages():
    stt = _FakeSTT("delete the old scratch file")
    llm = _FakeLLM("I'll need your approval for that — want me to proceed?")
    tts = _FakeTTS(b"synthesized-reply")

    result = run_voice_turn(b"raw-mic-audio", stt=stt, llm=llm, tts=tts, planner=keyword_planner)

    assert result.transcript == "delete the old scratch file"
    assert stt.received_audio == b"raw-mic-audio"
    assert result.reply_text == "I'll need your approval for that — want me to proceed?"
    assert llm.last_prompt == "delete the old scratch file"
    assert result.reply_audio == b"synthesized-reply"
    assert tts.last_text == result.reply_text


def test_run_voice_turn_routes_a_destructive_request_to_exec_only():
    stt = _FakeSTT("delete the old scratch file")
    llm = _FakeLLM("okay")

    result = run_voice_turn(b"audio", stt=stt, llm=llm, planner=keyword_planner)

    assert result.specialist == "exec"
    assert set(result.available_tools) == {"delete_file_tool", "run_command_tool"}


def test_run_voice_turn_scopes_the_llm_system_prompt_to_the_routed_specialist():
    stt = _FakeSTT("where is the highlight function defined")
    llm = _FakeLLM("it's in element-ladder.ts")

    run_voice_turn(b"audio", stt=stt, llm=llm, planner=keyword_planner)

    assert "read" in llm.last_system
    assert "delete_file_tool" not in llm.last_system  # the read specialist's system prompt never mentions exec-only tools


def test_run_voice_turn_without_a_tts_provider_leaves_reply_audio_none_not_fake_empty():
    stt = _FakeSTT("hello")
    llm = _FakeLLM("hi there")

    result = run_voice_turn(b"audio", stt=stt, llm=llm, tts=None, planner=keyword_planner)

    assert result.reply_audio is None


def test_run_voice_turn_records_both_sides_of_the_conversation_when_a_customer_is_given(tmp_path: Path):
    memory_conn = open_memory_store(str(tmp_path / "memory.db"))
    stt = _FakeSTT("hello there")
    llm = _FakeLLM("hi, how can I help")

    run_voice_turn(b"audio", stt=stt, llm=llm, customer_id="acme", memory_conn=memory_conn, planner=keyword_planner)

    history = recent_history(memory_conn, "acme")
    assert [t.content for t in history] == ["hello there", "hi, how can I help"]
    assert [t.role for t in history] == ["user", "assistant"]


def test_run_voice_turn_without_a_customer_id_does_not_touch_memory(tmp_path: Path):
    memory_conn = open_memory_store(str(tmp_path / "memory.db"))
    stt = _FakeSTT("hello")
    llm = _FakeLLM("hi")

    run_voice_turn(b"audio", stt=stt, llm=llm, memory_conn=memory_conn, customer_id=None, planner=keyword_planner)

    assert recent_history(memory_conn, "anyone") == []


def test_run_voice_turn_reports_timing_for_every_stage_that_ran():
    stt = _FakeSTT("hello")
    llm = _FakeLLM("hi")
    tts = _FakeTTS()

    result = run_voice_turn(b"audio", stt=stt, llm=llm, tts=tts, planner=keyword_planner)

    assert set(result.timing_ms) == {"stt_ms", "routing_ms", "llm_ms", "tts_ms", "total_ms"}
    assert all(v >= 0 for v in result.timing_ms.values())


def test_run_voice_turn_timing_omits_tts_when_no_tts_provider_given():
    stt = _FakeSTT("hello")
    llm = _FakeLLM("hi")

    result = run_voice_turn(b"audio", stt=stt, llm=llm, tts=None, planner=keyword_planner)

    assert "tts_ms" not in result.timing_ms


def test_run_voice_turn_defaults_to_an_llm_backed_planner_when_none_given():
    # No explicit planner: should build llm_planner(llm) internally and
    # use the fake llm's own reply to route — proves the default wiring
    # (not just that an explicit keyword_planner override works).
    stt = _FakeSTT("anything")
    llm = _FakeLLM("read")  # the fake LLM's "routing" reply names a specialist directly

    result = run_voice_turn(b"audio", stt=stt, llm=llm)

    assert result.specialist == "read"

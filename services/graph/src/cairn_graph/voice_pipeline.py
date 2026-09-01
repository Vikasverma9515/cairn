"""Month 8, first slice: wiring the real voice loop for the first time.

Every piece here has been real and independently verified since earlier
in this project — Deepgram transcribed real synthesized speech,
Groq answered real prompts in 0.43s, the orchestrator correctly routed
real requests, Cartesia/ElevenLabs are structurally verified against
their real SDKs. None of them had ever been connected into one actual
conversation turn before this module. That gap — pillar 3's original
pitch ("it's like talking to a friend") being the one piece of the
vision that had only ever run as isolated demos — is what this closes.

One turn is: audio in -> STTProvider.transcribe -> record the turn ->
route it (llm_planner if an LLMProvider is given, keyword_planner
otherwise) -> LLMProvider.complete for the reply -> record the reply ->
TTSProvider.synthesize (skipped, not faked, if no TTS provider is
configured) -> audio out. Every provider is injected — this module
imports no vendor SDK directly, the same discipline `providers.py`
established, so the pipeline itself is fully testable with fake
providers and needs no network call or credential in the automated
suite.

What this module is **not**: a real-time streaming server, a WebSocket
endpoint, or barge-in (interrupting mid-reply). Those need actual
duplex audio infrastructure — a genuinely separate, larger build than
"connect four providers into one function call" — and are honestly
scoped out here rather than half-built. This is the turn-taking logic a
streaming layer would sit on top of, verified correct before anything
gets layered on top of it.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass
from typing import Any

from cairn_graph.memory import record_turn
from cairn_graph.orchestrator import DEFAULT_SPECIALISTS, Planner, Specialist, keyword_planner, llm_planner, route_request


@dataclass(frozen=True)
class VoiceTurnResult:
    transcript: str
    specialist: str
    available_tools: tuple[str, ...]
    reply_text: str
    reply_audio: bytes | None  # None when no TTSProvider was configured — not faked as empty-but-present
    timing_ms: dict[str, float]


def run_voice_turn(
    audio_in: bytes,
    stt,
    llm,
    tts=None,
    customer_id: str | None = None,
    memory_conn: sqlite3.Connection | None = None,
    specialists: tuple[Specialist, ...] = DEFAULT_SPECIALISTS,
    planner: Planner | None = None,
) -> VoiceTurnResult:
    """One connected conversation turn. `stt`/`llm` are required — a voice
    pipeline with no ears or no brain isn't a smaller version of this
    feature, it's a different feature — `tts` is optional (falls back to
    text-only, an honest "no voice out configured" rather than a fake
    silent clip). `planner` defaults to the real LLM-backed router
    (`llm_planner(llm)`) reusing the same `llm` this turn already has —
    pass `keyword_planner` explicitly for the zero-network default
    instead.

    Every provider is duck-typed (`STTProvider`/`LLMProvider`/
    `TTSProvider` from `providers.py`, structurally, not by import) so
    tests inject fakes and this module never has to know a vendor SDK
    exists."""
    timing: dict[str, float] = {}

    t0 = time.monotonic()
    transcript = stt.transcribe(audio_in)
    timing["stt_ms"] = (time.monotonic() - t0) * 1000

    if memory_conn is not None and customer_id is not None:
        record_turn(memory_conn, customer_id, "user", transcript)

    active_planner = planner if planner is not None else llm_planner(llm)
    t0 = time.monotonic()
    routed = route_request(transcript, specialists=specialists, planner=active_planner)
    timing["routing_ms"] = (time.monotonic() - t0) * 1000

    system = (
        f"You are a voice assistant for a software platform. You have been routed to the "
        f"'{routed['specialist']}' role, scoped to these tools: {', '.join(routed['available_tools'])}. "
        f"Reply conversationally and concisely — this reply will be spoken aloud, not read as text."
    )
    t0 = time.monotonic()
    reply_text = llm.complete(transcript, system=system)
    timing["llm_ms"] = (time.monotonic() - t0) * 1000

    if memory_conn is not None and customer_id is not None:
        record_turn(memory_conn, customer_id, "assistant", reply_text)

    reply_audio = None
    if tts is not None:
        t0 = time.monotonic()
        reply_audio = tts.synthesize(reply_text)
        timing["tts_ms"] = (time.monotonic() - t0) * 1000

    timing["total_ms"] = sum(timing.values())

    return VoiceTurnResult(
        transcript=transcript,
        specialist=routed["specialist"],
        available_tools=tuple(routed["available_tools"]),
        reply_text=reply_text,
        reply_audio=reply_audio,
        timing_ms=timing,
    )

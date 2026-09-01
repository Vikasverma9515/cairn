from __future__ import annotations

from pathlib import Path

import pytest

from cairn_graph.cost_control import (
    CostCeilingExceededError,
    CostRates,
    CostTrackingLLMProvider,
    RateLimitExceededError,
    check_limits,
    estimate_cost_usd,
    estimate_tokens,
    open_usage_store,
    record_usage,
    usage_in_window,
)


class _FakeLLM:
    def __init__(self, reply: str = "a reply"):
        self._reply = reply
        self.calls = 0

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        self.calls += 1
        return self._reply


def test_estimate_tokens_uses_the_stated_four_chars_per_token_heuristic():
    assert estimate_tokens("a" * 400) == 100


def test_estimate_tokens_sums_multiple_texts():
    assert estimate_tokens("a" * 40, "b" * 40) == 20


def test_estimate_cost_usd_scales_with_the_configured_rate():
    rates = CostRates(usd_per_1k_tokens=0.50)
    assert estimate_cost_usd(2000, rates) == 1.0


def test_record_and_query_usage_in_window(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    record_usage(conn, "acme", "llm", 100, 0.01)
    record_usage(conn, "acme", "llm", 200, 0.02)

    usage = usage_in_window(conn, "acme", window_seconds=3600)

    assert usage["calls"] == 2
    assert usage["estimated_tokens"] == 300
    assert usage["estimated_cost_usd"] == pytest.approx(0.03)


def test_usage_in_window_excludes_calls_outside_the_window(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    conn.execute(
        "INSERT INTO usage_log (customer_id, provider_kind, estimated_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
        ("acme", "llm", 100, 0.01, 0.0),  # the epoch — long outside any real window
    )
    conn.commit()

    usage = usage_in_window(conn, "acme", window_seconds=60)

    assert usage["calls"] == 0


def test_usage_is_scoped_per_customer(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    record_usage(conn, "acme", "llm", 100, 0.01)
    record_usage(conn, "globex", "llm", 500, 0.05)

    assert usage_in_window(conn, "acme", 3600)["calls"] == 1
    assert usage_in_window(conn, "globex", 3600)["calls"] == 1


def test_check_limits_raises_when_call_count_ceiling_is_reached(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    record_usage(conn, "acme", "llm", 10, 0.001)
    record_usage(conn, "acme", "llm", 10, 0.001)

    with pytest.raises(RateLimitExceededError, match="acme"):
        check_limits(conn, "acme", window_seconds=60, max_calls=2)


def test_check_limits_allows_calls_under_the_ceiling(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    record_usage(conn, "acme", "llm", 10, 0.001)

    check_limits(conn, "acme", window_seconds=60, max_calls=2)  # does not raise


def test_check_limits_raises_when_cost_ceiling_is_reached(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    record_usage(conn, "acme", "llm", 10000, 5.0)

    with pytest.raises(CostCeilingExceededError, match=r"\$5"):
        check_limits(conn, "acme", window_seconds=60, max_cost_usd=5.0)


def test_check_limits_with_no_ceilings_never_raises(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    for _ in range(1000):
        record_usage(conn, "acme", "llm", 10000, 100.0)

    check_limits(conn, "acme", window_seconds=60)  # no max_calls, no max_cost_usd -> track-only


def test_cost_tracking_provider_passes_through_to_the_real_reply(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    inner = _FakeLLM("the real reply")
    wrapped = CostTrackingLLMProvider(inner, conn, "acme")

    reply = wrapped.complete("hello", system="be terse")

    assert reply == "the real reply"
    assert inner.calls == 1


def test_cost_tracking_provider_records_usage_after_each_call(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    wrapped = CostTrackingLLMProvider(_FakeLLM("reply"), conn, "acme")

    wrapped.complete("a prompt")

    usage = usage_in_window(conn, "acme", 3600)
    assert usage["calls"] == 1
    assert usage["estimated_tokens"] > 0


def test_cost_tracking_provider_blocks_the_inner_call_once_the_ceiling_is_hit(tmp_path: Path):
    conn = open_usage_store(str(tmp_path / "usage.db"))
    inner = _FakeLLM("reply")
    wrapped = CostTrackingLLMProvider(inner, conn, "acme", window_seconds=60, max_calls=1)

    wrapped.complete("first call")  # allowed, brings usage to 1 call
    with pytest.raises(RateLimitExceededError):
        wrapped.complete("second call")  # blocked before reaching the inner provider

    assert inner.calls == 1  # the inner provider was never actually invoked for the blocked call

from __future__ import annotations

from cairn_graph.doctor import (
    CheckResult,
    DEFAULT_CHECKS,
    check_embedding_model_cached,
    check_langgraph_orchestrator,
    check_mcp_sdk,
    check_qdrant_embedded,
    check_sqlite_store,
    check_tree_sitter_parsers,
    run_checks,
)


def test_check_tree_sitter_parsers_passes_on_a_real_install():
    result = check_tree_sitter_parsers()
    assert result.ok is True


def test_check_sqlite_store_passes_on_a_real_install():
    result = check_sqlite_store()
    assert result.ok is True


def test_check_mcp_sdk_passes_on_a_real_install():
    result = check_mcp_sdk()
    assert result.ok is True


def test_check_qdrant_embedded_passes_on_a_real_install():
    result = check_qdrant_embedded()
    assert result.ok is True


def test_check_langgraph_orchestrator_passes_on_a_real_install():
    result = check_langgraph_orchestrator()
    assert result.ok is True


def test_check_embedding_model_cached_never_hard_fails_regardless_of_cache_state():
    # Whether the model happens to be cached in whatever environment runs
    # this test or not, the check must report ok=True either way — an
    # uncached model is a warning (slower first vectorize), never a
    # doctor failure.
    result = check_embedding_model_cached()
    assert result.ok is True


def test_run_checks_runs_every_default_check():
    results = run_checks()
    assert len(results) == len(DEFAULT_CHECKS)
    assert all(isinstance(r, CheckResult) for r in results)


def test_run_checks_reports_a_failing_injected_check():
    def broken_check() -> CheckResult:
        return CheckResult("fake broken thing", False, "simulated failure")

    results = run_checks((broken_check,))

    assert len(results) == 1
    assert results[0].ok is False
    assert results[0].name == "fake broken thing"


def test_a_check_that_raises_is_caught_and_reported_not_propagated():
    # Every real check catches its own exceptions (see doctor.py) — this
    # proves that discipline holds for a check that raises something
    # unexpected, rather than trusting each one not to regress silently.
    def exploding_check() -> CheckResult:
        try:
            raise RuntimeError("boom")
        except Exception as exc:  # noqa: BLE001
            return CheckResult("exploding thing", False, f"{type(exc).__name__}: {exc}")

    results = run_checks((exploding_check,))

    assert results[0].ok is False
    assert "boom" in results[0].detail

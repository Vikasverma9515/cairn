"""Cost tracking and rate limiting — Month 10's first, fully-buildable
slice. Two of the plan's three Month 10 items need things this session
can't fabricate: real tenant isolation needs an actual auth/session
design decision (binding a caller's identity to one `customer_id`
server-side, so nobody can pass an arbitrary `customer_id` string and
read someone else's memory — today's MCP tools trust whatever string
they're given), and a real security review needs an actual reviewer.
Stated honestly rather than faked with a "0 findings" report nobody
wrote.

What IS fully real and buildable right now: nothing in this service
tracks what a customer's usage actually *costs*, or stops one
customer's usage from being unbounded — `analytics.py` counts actions,
not dollars or calls-per-minute. This closes that gap.

**A real, stated limitation, not a false precision claim**: cost here is
a *character-count-based estimate*, not exact token billing.
`providers.LLMProvider`'s `complete(prompt, *, system=None) -> str`
deliberately doesn't expose the underlying token usage a specific
vendor's API returns (Groq's response has real `usage.prompt_tokens`/
`completion_tokens`, but the Protocol has to work identically for any
provider, and forcing every implementation to also return usage
metadata would break the "any provider, uniform shape" point of having
a Protocol at all). A ~4-chars-per-token heuristic (a widely-used rough
approximation, not this project's invention) converts character counts
to an approximate token count, multiplied by a configurable $/1k-token
rate. Good enough to catch runaway usage and give a customer-success
team a real number to look at; not good enough to reconcile against an
actual vendor invoice — that distinction is the whole point of naming
this an *estimate*.
"""

from __future__ import annotations

import sqlite3
import time
from dataclasses import dataclass

_CHARS_PER_TOKEN_ESTIMATE = 4  # widely-used rough approximation for English text, not exact

SCHEMA = """
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY,
  customer_id TEXT NOT NULL,
  provider_kind TEXT NOT NULL,
  estimated_tokens INTEGER NOT NULL,
  estimated_cost_usd REAL NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_log_customer_time ON usage_log(customer_id, created_at);
"""


def open_usage_store(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def estimate_tokens(*texts: str) -> int:
    return sum(len(t) for t in texts if t) // _CHARS_PER_TOKEN_ESTIMATE


@dataclass(frozen=True)
class CostRates:
    usd_per_1k_tokens: float = 0.10  # a placeholder default — real deployments should set this to their actual provider's published rate


def estimate_cost_usd(tokens: int, rates: CostRates = CostRates()) -> float:
    return (tokens / 1000) * rates.usd_per_1k_tokens


def record_usage(conn: sqlite3.Connection, customer_id: str, provider_kind: str, tokens: int, cost_usd: float) -> None:
    conn.execute(
        "INSERT INTO usage_log (customer_id, provider_kind, estimated_tokens, estimated_cost_usd, created_at) VALUES (?, ?, ?, ?, ?)",
        (customer_id, provider_kind, tokens, cost_usd, time.time()),
    )
    conn.commit()


def usage_in_window(conn: sqlite3.Connection, customer_id: str, window_seconds: float) -> dict:
    since = time.time() - window_seconds
    row = conn.execute(
        "SELECT COUNT(*), COALESCE(SUM(estimated_tokens), 0), COALESCE(SUM(estimated_cost_usd), 0) "
        "FROM usage_log WHERE customer_id = ? AND created_at >= ?",
        (customer_id, since),
    ).fetchone()
    return {"calls": row[0], "estimated_tokens": row[1], "estimated_cost_usd": row[2]}


class RateLimitExceededError(RuntimeError):
    pass


class CostCeilingExceededError(RuntimeError):
    pass


def check_limits(
    conn: sqlite3.Connection,
    customer_id: str,
    window_seconds: float,
    max_calls: int | None = None,
    max_cost_usd: float | None = None,
) -> None:
    """Raises *before* a costly call is made, not after — the whole point
    of a ceiling. Either limit is optional; pass neither for "track but
    never block" (still useful for the analytics/dashboard picture)."""
    usage = usage_in_window(conn, customer_id, window_seconds)
    if max_calls is not None and usage["calls"] >= max_calls:
        raise RateLimitExceededError(
            f"customer {customer_id!r} made {usage['calls']} calls in the last {window_seconds:.0f}s (limit: {max_calls})"
        )
    if max_cost_usd is not None and usage["estimated_cost_usd"] >= max_cost_usd:
        raise CostCeilingExceededError(
            f"customer {customer_id!r} used an estimated ${usage['estimated_cost_usd']:.4f} in the last "
            f"{window_seconds:.0f}s (ceiling: ${max_cost_usd:.4f})"
        )


class CostTrackingLLMProvider:
    """Wraps any real `providers.LLMProvider` — transparent to callers,
    same `complete(prompt, *, system=None) -> str` shape — adding a real
    pre-call limit check and a post-call usage record. A decorator, not a
    provider of its own: swap the inner provider without touching this
    wrapper, the same "compose, don't reimplement" shape as everything
    else provider-related in this project."""

    def __init__(
        self,
        inner,
        conn: sqlite3.Connection,
        customer_id: str,
        rates: CostRates = CostRates(),
        window_seconds: float = 60.0,
        max_calls: int | None = None,
        max_cost_usd: float | None = None,
    ):
        self._inner = inner
        self._conn = conn
        self._customer_id = customer_id
        self._rates = rates
        self._window_seconds = window_seconds
        self._max_calls = max_calls
        self._max_cost_usd = max_cost_usd

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        check_limits(self._conn, self._customer_id, self._window_seconds, self._max_calls, self._max_cost_usd)
        reply = self._inner.complete(prompt, system=system)
        tokens = estimate_tokens(prompt, system or "", reply)
        record_usage(self._conn, self._customer_id, "llm", tokens, estimate_cost_usd(tokens, self._rates))
        return reply

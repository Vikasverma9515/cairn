"""`cairn-graph doctor` — Month 6's first hardening slice: check that an
install actually works before a customer (or a CI job, or a support
engineer three months from now) finds out the hard way that one piece
silently isn't wired up right.

Every check is a plain function returning a `CheckResult` so the whole
thing is unit-testable without needing a broken environment to prove a
check fails — tests inject a broken variant of the check function
directly rather than trying to actually corrupt a venv.

Deliberately does **not** trigger the one slow/network step in this
service (downloading the embedding model) just to check it — `run_checks`
reports whether the model is *already* cached, not whether it *can be*
downloaded, so `doctor` stays fast and safe to run repeatedly, including
on an air-gapped machine that hasn't run `vectorize` yet.
"""

from __future__ import annotations

import sqlite3
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str
    warning: bool = False  # ok=True but worth flagging (e.g. model not cached yet)


def check_tree_sitter_parsers() -> CheckResult:
    try:
        from cairn_graph.languages import language_for_path, parser_for

        # Goes through the same extension -> LanguageSpec -> Parser path a
        # real build() call takes, not a hand-built LanguageSpec — found
        # live: parser_for() takes the LanguageSpec object, not a bare
        # language-id string, and the first version of this check passed
        # a string and crashed with an AttributeError immediately on the
        # first real `doctor` run.
        for ext in (".ts", ".tsx", ".js", ".py"):
            spec = language_for_path(f"doctor{ext}")
            parser_for(spec)
        return CheckResult("tree-sitter parsers", True, "typescript, tsx, javascript, python all load")
    except Exception as exc:  # noqa: BLE001 — a doctor check must never itself crash the command
        return CheckResult("tree-sitter parsers", False, f"{type(exc).__name__}: {exc}")


def check_sqlite_store() -> CheckResult:
    try:
        from cairn_graph.store import open_store

        with tempfile.TemporaryDirectory() as tmp:
            conn = open_store(str(Path(tmp) / "doctor.db"))
            conn.execute("SELECT 1")
            fk = conn.execute("PRAGMA foreign_keys").fetchone()[0]
            if not fk:
                return CheckResult("sqlite store", False, "PRAGMA foreign_keys did not take effect")
        return CheckResult("sqlite store", True, "opens, WAL + foreign_keys both active")
    except Exception as exc:  # noqa: BLE001
        return CheckResult("sqlite store", False, f"{type(exc).__name__}: {exc}")


def check_mcp_sdk() -> CheckResult:
    try:
        from mcp.server.mcpserver import MCPServer

        MCPServer("doctor-check")
        return CheckResult("mcp sdk", True, "mcp.server.mcpserver.MCPServer importable and constructible")
    except ModuleNotFoundError as exc:
        return CheckResult("mcp sdk", False, f"not installed or wrong version: {exc}")
    except Exception as exc:  # noqa: BLE001
        return CheckResult("mcp sdk", False, f"{type(exc).__name__}: {exc}")


def check_qdrant_embedded() -> CheckResult:
    try:
        from qdrant_client import QdrantClient

        with tempfile.TemporaryDirectory() as tmp:
            client = QdrantClient(path=str(Path(tmp) / "doctor-vectors"))
            client.collection_exists("doctor")  # any real call proves the embedded backend works
        return CheckResult("qdrant embedded", True, "opens a local collection store with no server process")
    except Exception as exc:  # noqa: BLE001
        return CheckResult("qdrant embedded", False, f"{type(exc).__name__}: {exc}")


def check_langgraph_orchestrator() -> CheckResult:
    try:
        from cairn_graph.orchestrator import route_request

        result = route_request("where is X defined?")
        if result["specialist"] != "read":
            return CheckResult("langgraph orchestrator", False, f"unexpected routing result: {result}")
        return CheckResult("langgraph orchestrator", True, "StateGraph compiles and routes correctly")
    except Exception as exc:  # noqa: BLE001
        return CheckResult("langgraph orchestrator", False, f"{type(exc).__name__}: {exc}")


def check_embedding_model_cached() -> CheckResult:
    """A warning, never a hard failure — an uncached model just means the
    first real `vectorize` call will take longer while it downloads."""
    try:
        from huggingface_hub import scan_cache_dir
        from huggingface_hub.errors import CacheNotFound

        try:
            info = scan_cache_dir()
        except CacheNotFound:
            return CheckResult(
                "embedding model cache", True, f"{EMBEDDING_MODEL} not cached yet — first `vectorize` will download it", warning=True
            )
        cached_ids = {repo.repo_id for repo in info.repos}
        if EMBEDDING_MODEL in cached_ids:
            return CheckResult("embedding model cache", True, f"{EMBEDDING_MODEL} already cached locally")
        return CheckResult(
            "embedding model cache", True, f"{EMBEDDING_MODEL} not cached yet — first `vectorize` will download it", warning=True
        )
    except Exception as exc:  # noqa: BLE001
        return CheckResult("embedding model cache", False, f"{type(exc).__name__}: {exc}")


DEFAULT_CHECKS: tuple[Callable[[], CheckResult], ...] = (
    check_tree_sitter_parsers,
    check_sqlite_store,
    check_mcp_sdk,
    check_qdrant_embedded,
    check_langgraph_orchestrator,
    check_embedding_model_cached,
)


def run_checks(checks: tuple[Callable[[], CheckResult], ...] = DEFAULT_CHECKS) -> list[CheckResult]:
    return [check() for check in checks]

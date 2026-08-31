"""Walks a directory into the structure graph: discover -> hash -> parse
(sharded across a real process pool) -> write, incrementally.

The three guarantees this module exists to make:

1. One bad file can never crash the run. A generated 50,000-line bundle,
   a file tree-sitter's error-recovery chokes on, a permissions error —
   each is caught inside the worker, recorded as a failed file with the
   reason, and the run continues. Nothing here lets one file's problem
   take down the shard it's in, let alone the whole index.
2. An unchanged file is never re-parsed. Content is hashed (sha256) and
   compared against what's already stored; only new or changed files
   enter the worker pool at all. This is *the* lever that keeps a
   lakhs-of-files repo's second-and-later index fast — most files are
   unchanged between runs, and Cairn should behave that way.
3. The whole incremental run commits to SQLite once, not once per file —
   see store.py's docstring for why that specific choice matters on
   network-mounted storage.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for, supported_extensions
from cairn_graph.store import existing_hashes, open_store, upsert_file

# Directories that are never source of truth for a codebase's own
# structure — walking into them wastes real time at "lakhs of files"
# scale and, for node_modules/vendor especially, can 10-100x the file
# count with code that isn't the customer's own.
_EXCLUDED_DIR_NAMES = {
    "node_modules", ".git", "dist", "build", "out", ".next",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
    "coverage", ".turbo", "vendor",
}


@dataclass(frozen=True)
class FileOutcome:
    path: str
    language: str
    content_hash: str
    status: str  # "ok" | "failed"
    error: str | None
    symbol_count: int
    # The extracted records travel as plain tuples-of-primitives (not the
    # ExtractResult dataclass directly) so this stays cheaply picklable
    # across the process-pool boundary regardless of how extract.py's
    # internal types evolve.
    symbols: tuple[tuple[str, str, int, int, bool, str | None], ...]
    imports: tuple[tuple[str, tuple[str, ...], bool, int], ...]
    calls: tuple[tuple[str | None, str, int], ...]
    framework_roots: tuple[str, ...] = ()


@dataclass
class BuildSummary:
    total_files_seen: int
    parsed: int
    skipped_unchanged: int
    failed: int
    removed: int
    duration_seconds: float
    failures: list[tuple[str, str]]  # (path, error) — surfaced, never silently dropped


def discover_files(root: str) -> list[str]:
    exts = supported_extensions()
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _EXCLUDED_DIR_NAMES and not d.startswith(".")]
        for name in filenames:
            if name.endswith(exts):
                found.append(str(Path(dirpath) / name))
    return found


def _hash_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# Hand-written source, even dense source, essentially never averages this
# many characters per line — a real newline follows most statements.
# Minifiers/bundlers deliberately strip newlines to save bytes, which is
# exactly the signal this reads. 300 is conservative on purpose: a false
# "not generated" (a genuinely dense file slips through) just means one
# more file gets indexed normally, not a wrongly-skipped real file.
_GENERATED_AVG_LINE_LENGTH = 300


def _looks_generated(data: bytes) -> bool:
    if not data:
        return False
    line_count = data.count(b"\n") + 1
    return (len(data) / line_count) > _GENERATED_AVG_LINE_LENGTH


def _parse_one(path: str) -> FileOutcome:
    """Runs inside a worker process. Must never raise past this point —
    every failure mode (unreadable file, unsupported grammar edge case,
    tree-sitter itself erroring) becomes a FileOutcome with status
    "failed" instead of an exception that would otherwise take down the
    worker or, worse, silently drop the file from the index with no
    record of why."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except OSError as e:
        return FileOutcome(path, "unknown", "", "failed", f"unreadable: {e}", 0, (), (), ())

    content_hash = _hash_bytes(data)
    spec = language_for_path(path)
    if spec is None:
        return FileOutcome(path, "unknown", content_hash, "failed", "no grammar for this extension", 0, (), (), ())

    if _looks_generated(data):
        # A checked-in bundler output file (found live: a real esbuild
        # bundle under examples/demo-app/public/) parses without error but
        # produces meaningless single/double-letter symbol names that both
        # pollute search results and badly skew reachability — a
        # minified-away name can't collide-match anything real, so
        # everything downstream of it reads as falsely dead. Skipped
        # before parsing, not silently indexed as garbage.
        return FileOutcome(path, spec.id, content_hash, "skipped_generated", "looks minified/generated", 0, (), (), ())

    try:
        parser = parser_for(spec)
        tree = parser.parse(data)
        result = extract(tree.root_node, data, language=spec.id)
    except Exception as e:  # noqa: BLE001 — deliberately broad: any parser/extractor bug must degrade this one file, never the run
        return FileOutcome(path, spec.id, content_hash, "failed", f"{type(e).__name__}: {e}", 0, (), (), ())

    return FileOutcome(
        path=path,
        language=spec.id,
        content_hash=content_hash,
        status="ok",
        error=None,
        symbol_count=len(result.symbols),
        symbols=tuple((s.kind, s.name, s.start_line, s.end_line, s.exported, s.parent) for s in result.symbols),
        imports=tuple((i.source, i.names, i.is_relative, i.line) for i in result.imports),
        calls=tuple((c.caller, c.callee, c.line) for c in result.calls),
        framework_roots=tuple(result.framework_roots),
    )


def _outcome_to_extract_result(outcome: FileOutcome):
    from cairn_graph.extract import CallEdge, ExtractResult, ImportRecord, Symbol

    return ExtractResult(
        symbols=[Symbol(kind=k, name=n, start_line=sl, end_line=el, exported=exp, parent=p) for (k, n, sl, el, exp, p) in outcome.symbols],
        imports=[ImportRecord(source=s, names=n, is_relative=r, line=l) for (s, n, r, l) in outcome.imports],
        calls=[CallEdge(caller=c, callee=cal, line=l) for (c, cal, l) in outcome.calls],
        framework_roots=list(outcome.framework_roots),
    )


def build_graph(root: str, db_path: str, workers: int | None = None, quiet: bool = False) -> BuildSummary:
    started = time.time()
    conn = open_store(db_path)
    try:
        return _build(conn, root, workers, quiet)
    finally:
        conn.close()


def _build(conn: sqlite3.Connection, root: str, workers: int | None, quiet: bool) -> BuildSummary:
    started = time.time()
    all_files = discover_files(root)
    known = existing_hashes(conn)

    on_disk = set(all_files)
    removed_paths = [p for p in known if p not in on_disk]

    to_parse: list[str] = []
    skipped = 0
    # Cheap first pass: hash every file's *current* bytes and compare to
    # what's stored before deciding whether it needs the (much more
    # expensive) parse step at all.
    file_hashes: dict[str, str] = {}
    for path in all_files:
        try:
            with open(path, "rb") as f:
                file_hashes[path] = _hash_bytes(f.read())
        except OSError:
            to_parse.append(path)  # let _parse_one produce the real failure record
            continue
        if known.get(path) == file_hashes[path]:
            skipped += 1
        else:
            to_parse.append(path)

    outcomes: list[FileOutcome] = []
    worker_count = workers or max(1, (os.cpu_count() or 4) - 1)
    if to_parse:
        with ProcessPoolExecutor(max_workers=worker_count) as pool:
            futures = {pool.submit(_parse_one, path): path for path in to_parse}
            for future in as_completed(futures):
                outcomes.append(future.result())

    failures: list[tuple[str, str]] = []
    with conn:  # one transaction for the whole incremental run — see store.py
        for path in removed_paths:
            conn.execute("DELETE FROM files WHERE path = ?", (path,))
        for outcome in outcomes:
            extract_result = _outcome_to_extract_result(outcome) if outcome.status == "ok" else None
            upsert_file(conn, outcome.path, outcome.language, outcome.content_hash, outcome.status, extract_result, outcome.error)
            if outcome.status != "ok":
                failures.append((outcome.path, outcome.error or "unknown error"))

    return BuildSummary(
        total_files_seen=len(all_files),
        parsed=len([o for o in outcomes if o.status == "ok"]),
        skipped_unchanged=skipped,
        failed=len(failures),
        removed=len(removed_paths),
        duration_seconds=time.time() - started,
        failures=failures,
    )

from __future__ import annotations

import sqlite3
from pathlib import Path

from cairn_graph.build import build_graph


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_builds_a_small_real_directory_end_to_end(tmp_path: Path):
    write(tmp_path / "src/a.ts", "export function fromA() { return fromB(); }")
    write(tmp_path / "src/b.ts", "export function fromB() { return 1; }")
    write(tmp_path / "node_modules/dep/index.ts", "export function shouldBeExcluded() {}")

    db = tmp_path / "graph.db"
    summary = build_graph(str(tmp_path), str(db))

    assert summary.parsed == 2  # node_modules excluded, so only a.ts + b.ts
    assert summary.failed == 0

    conn = sqlite3.connect(str(db))
    names = {row[0] for row in conn.execute("SELECT name FROM symbols")}
    assert names == {"fromA", "fromB"}
    assert conn.execute("SELECT COUNT(*) FROM files WHERE path LIKE '%node_modules%'").fetchone()[0] == 0


def test_second_build_with_no_changes_skips_every_file(tmp_path: Path):
    write(tmp_path / "src/a.ts", "export function fromA() {}")
    db = tmp_path / "graph.db"

    first = build_graph(str(tmp_path), str(db))
    assert first.parsed == 1

    second = build_graph(str(tmp_path), str(db))
    assert second.parsed == 0
    assert second.skipped_unchanged == 1


def test_changing_one_file_only_reparses_that_file(tmp_path: Path):
    write(tmp_path / "src/a.ts", "export function fromA() {}")
    write(tmp_path / "src/b.ts", "export function fromB() {}")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    write(tmp_path / "src/a.ts", "export function fromA() { return 2; }")
    summary = build_graph(str(tmp_path), str(db))

    assert summary.parsed == 1
    assert summary.skipped_unchanged == 1


def test_deleting_a_file_removes_it_and_its_symbols_from_the_graph(tmp_path: Path):
    write(tmp_path / "src/a.ts", "export function fromA() {}")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    (tmp_path / "src/a.ts").unlink()
    summary = build_graph(str(tmp_path), str(db))

    assert summary.removed == 1
    conn = sqlite3.connect(str(db))
    assert conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM symbols").fetchone()[0] == 0


def test_one_unparseable_file_does_not_crash_the_run_or_hide_the_others(tmp_path: Path):
    # A file with a name tree-sitter has no grammar for at all — the
    # sharpest version of "this file can't be understood".
    write(tmp_path / "src/a.ts", "export function fromA() {}")
    write(tmp_path / "src/notes.md", "# just some prose, wrong extension entirely")
    # Genuinely malformed TS — tree-sitter's error recovery should still
    # return *a* tree rather than raising, but this proves the pipeline
    # survives even if some future grammar/version combination doesn't.
    write(tmp_path / "src/broken.ts", "export function (((( not valid at all")

    db = tmp_path / "graph.db"
    summary = build_graph(str(tmp_path), str(db))

    # a.ts must still be indexed even though broken.ts is a mess nearby.
    conn = sqlite3.connect(str(db))
    names = {row[0] for row in conn.execute("SELECT name FROM symbols")}
    assert "fromA" in names
    # broken.ts is recorded (not silently dropped) — tree-sitter's error
    # recovery means this usually "succeeds" with a partial tree rather
    # than failing outright, which is itself the correct degrade: some
    # structure beats none.
    row = conn.execute("SELECT parse_status FROM files WHERE path LIKE '%broken.ts'").fetchone()
    assert row is not None
    assert summary.parsed >= 1  # at minimum a.ts made it through


def test_stats_reports_sane_counts(tmp_path: Path):
    write(tmp_path / "src/a.ts", 'import { x } from "./b";\nexport function fromA() { return x(); }')
    write(tmp_path / "src/b.ts", "export function x() {}")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    from cairn_graph.store import open_store, stats

    conn = open_store(str(db))
    s = stats(conn)
    assert s["files"] == 2
    assert s["symbols"] == 2
    assert s["imports"] == 1
    assert s["calls"] >= 1
    assert s["failed_files"] == 0

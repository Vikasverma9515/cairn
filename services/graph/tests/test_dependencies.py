from __future__ import annotations

from pathlib import Path

from cairn_graph.build import build_graph
from cairn_graph.dependencies import dependency_summary, file_dependencies, file_dependents, find_cycles
from cairn_graph.store import open_store


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_file_dependencies_resolves_a_relative_ts_import(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./b";\nexport function entry() { return helper(); }')
    write(tmp_path / "b.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "a.ts"))

    assert deps.internal == (str(tmp_path / "b.ts"),)
    assert deps.external == ()


def test_file_dependencies_resolves_a_directory_index_import(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./lib";\nexport function entry() { return helper(); }')
    write(tmp_path / "lib" / "index.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "a.ts"))

    assert deps.internal == (str(tmp_path / "lib" / "index.ts"),)


def test_file_dependencies_reports_a_package_import_as_external(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { useState } from "react";\nexport function entry() { return useState; }')
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "a.ts"))

    assert deps.internal == ()
    assert deps.external == ("react",)


def test_file_dependencies_resolves_a_python_relative_import(tmp_path: Path):
    write(tmp_path / "a.py", "from .utils import helper\n")
    write(tmp_path / "utils.py", "def helper():\n    return 1\n")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "a.py"))

    assert deps.internal == (str(tmp_path / "utils.py"),)


def test_file_dependencies_resolves_a_python_relative_import_from_a_package_init(tmp_path: Path):
    write(tmp_path / "pkg" / "a.py", "from . import shared\n")
    write(tmp_path / "pkg" / "__init__.py", "shared = 1\n")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "pkg" / "a.py"))

    assert deps.internal == (str(tmp_path / "pkg" / "__init__.py"),)


def test_file_dependencies_for_a_go_absolute_import_is_reported_as_external(tmp_path: Path):
    # Go has no relative-import concept — extract.py always records
    # is_relative=False for it, so every Go import is external here by
    # design, not a gap.
    write(tmp_path / "main.go", 'package main\n\nimport "fmt"\n\nfunc main() { fmt.Println("hi") }\n')
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    deps = file_dependencies(conn, str(tmp_path / "main.go"))

    assert deps.internal == ()
    assert deps.external == ("fmt",)


def test_file_dependents_is_the_reverse_of_file_dependencies(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./shared";\n')
    write(tmp_path / "b.ts", 'import { helper } from "./shared";\n')
    write(tmp_path / "shared.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    dependents = file_dependents(conn, str(tmp_path / "shared.ts"))

    assert set(dependents) == {str(tmp_path / "a.ts"), str(tmp_path / "b.ts")}


def test_find_cycles_detects_a_real_import_cycle(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { b } from "./b";\nexport function a() { return b(); }')
    write(tmp_path / "b.ts", 'import { a } from "./a";\nexport function b() { return a(); }')
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    cycles = find_cycles(conn)

    assert len(cycles) >= 1
    flat = {p for cycle in cycles for p in cycle}
    assert str(tmp_path / "a.ts") in flat
    assert str(tmp_path / "b.ts") in flat


def test_find_cycles_reports_none_for_an_acyclic_graph(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./b";\n')
    write(tmp_path / "b.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    assert find_cycles(conn) == []


def test_dependency_summary_ranks_most_depended_on_files(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./shared";\n')
    write(tmp_path / "b.ts", 'import { helper } from "./shared";\n')
    write(tmp_path / "c.ts", 'import { helper } from "./shared";\n')
    write(tmp_path / "shared.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    summary = dependency_summary(conn)

    assert summary["most_depended_on"][0]["file"] == str(tmp_path / "shared.ts")
    assert summary["most_depended_on"][0]["dependent_count"] == 3
    assert summary["cycle_count"] == 0


def test_dependency_summary_lists_files_with_no_internal_dependents(tmp_path: Path):
    write(tmp_path / "entry.ts", 'import { helper } from "./lib";\n')
    write(tmp_path / "lib.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    summary = dependency_summary(conn)

    assert str(tmp_path / "entry.ts") in summary["files_with_no_internal_dependents"]
    assert str(tmp_path / "lib.ts") not in summary["files_with_no_internal_dependents"]

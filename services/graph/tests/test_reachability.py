from __future__ import annotations

from pathlib import Path

from cairn_graph.build import build_graph
from cairn_graph.reachability import compute_dead_symbols
from cairn_graph.store import open_store


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


def test_unreferenced_unexported_function_is_dead(tmp_path: Path):
    write(tmp_path / "a.ts", "export function used() { return 1; }\nfunction neverCalled() { return 2; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "neverCalled" in dead_names
    assert "used" not in dead_names  # exported — never dead by this heuristic


def test_transitively_reachable_symbol_is_not_dead(tmp_path: Path):
    # exported -> calls middle -> middle calls bottom. Neither middle nor
    # bottom is exported or directly called by an export — only reachable
    # by walking the chain, which is the actual point of this test.
    write(
        tmp_path / "a.ts",
        """
        export function entry() { return middle(); }
        function middle() { return bottom(); }
        function bottom() { return 42; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert dead_names == set()  # entry, middle, and bottom are all reachable


def test_symbol_only_reached_via_cross_file_import_is_not_dead(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./b";\nexport function entry() { return helper(); }')
    write(tmp_path / "b.ts", "function helper() { return 1; }")  # not exported — imported anyway (re-export style)
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names


def test_class_instantiated_via_new_is_reachable_with_its_whole_call_chain(tmp_path: Path):
    # Found live: a class only ever used via `new Widget()` (never called
    # as `Widget()`) had its constructor, and everything the constructor
    # calls, read as dead — `new_expression` wasn't captured as a call
    # edge at all. This is the regression test for that fix.
    write(
        tmp_path / "a.ts",
        """
        export function setup() { return new Widget(); }
        class Widget {
          constructor() { this.wire(); }
          wire() { return helper(); }
        }
        function helper() { return 1; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "wire" not in dead_names
    assert "helper" not in dead_names


def test_class_only_instantiated_by_a_framework_registration_is_not_dead(tmp_path: Path):
    # Regression test for the exact case found dogfooding against Cairn's
    # own web-component.ts: a class registered via customElements.define
    # and never explicitly `new`'d anywhere in the codebase — the browser
    # instantiates it. Without framework-root detection, the class and
    # everything its methods call reads as entirely dead.
    write(
        tmp_path / "widget.ts",
        """
        class Widget extends HTMLElement {
          connectedCallback() { this.setup(); }
          setup() { return helper(); }
        }
        function helper() { return 1; }
        customElements.define("my-widget", Widget);
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "connectedCallback" not in dead_names
    assert "setup" not in dead_names
    assert "helper" not in dead_names


def test_symbol_used_only_inside_an_anonymous_top_level_callback_is_not_dead(tmp_path: Path):
    # The describe()/it() pattern every *.test.ts file in this repo uses:
    # the callback passed to describe() is anonymous, so a helper used only
    # inside it has no named "caller" to traverse from. Found live:
    # every local test-fixture class in l3-describe.test.ts read as dead
    # without this, since FakeClient/PartiallyFailingClient/etc are only
    # ever `new`'d inside describe()'s anonymous callback.
    write(
        tmp_path / "a.test.ts",
        """
        class FakeClient { call() { return 1; } }
        describe("something", () => {
          it("works", () => {
            const client = new FakeClient();
          });
        });
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "FakeClient" not in dead_names


def test_component_used_only_as_jsx_is_not_dead(tmp_path: Path):
    # <CairnMark /> is a bare identifier reference, not a call_expression
    # — found live: this exact pattern (packages/sdk/src/index.tsx) read
    # as dead before general reference tracking was added.
    write(
        tmp_path / "a.tsx",
        """
        function CairnMark() { return null; }
        export function App() { return <CairnMark />; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    assert "CairnMark" not in {s.name for s in result.dead}


def test_callback_passed_by_reference_is_not_dead(tmp_path: Path):
    # onClick={handleArchive} passes the function as a value, never calls
    # it directly — found live in examples/demo-app's real components.
    write(
        tmp_path / "a.tsx",
        """
        function handleArchive() { return 1; }
        export function Row() { return <button onClick={handleArchive} />; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    assert "handleArchive" not in {s.name for s in result.dead}


def test_type_used_only_in_an_annotation_is_not_dead(tmp_path: Path):
    write(
        tmp_path / "a.ts",
        """
        interface Status { code: number; }
        export function report(): Status { return { code: 1 }; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    assert "Status" not in {s.name for s in result.dead}


def test_reference_tracking_does_not_make_everything_reachable(tmp_path: Path):
    # The critical regression guard: general reference tracking must not
    # degrade into "every declared name is trivially reachable" (which
    # would happen if a declaration's own name node were counted as a
    # reference to itself). A truly unused, unexported function with no
    # reference anywhere else must still read as dead.
    write(
        tmp_path / "a.ts",
        """
        export function used() { return 1; }
        function trulyDead() { return 2; }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    assert "trulyDead" in {s.name for s in result.dead}
    assert "used" not in {s.name for s in result.dead}


def test_genuinely_isolated_file_is_entirely_dead(tmp_path: Path):
    write(tmp_path / "used.ts", "export function entry() { return 1; }")
    write(tmp_path / "orphan.ts", "function orphanFn() { return helperNoOneCalls(); }\nfunction helperNoOneCalls() { return 2; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "orphanFn" in dead_names
    assert "helperNoOneCalls" in dead_names

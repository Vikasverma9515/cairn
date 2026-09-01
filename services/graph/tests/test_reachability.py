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


def test_go_reachability_end_to_end(tmp_path: Path):
    # Proves the whole pipeline (build_graph -> compute_dead_symbols), not
    # just extraction in isolation — an exported entry point calling a
    # private helper and instantiating+using a struct via a receiver
    # method, plus one genuinely unused private function as the negative
    # case.
    write(
        tmp_path / "widget.go",
        """
        package main

        type Widget struct{}

        func NewWidget() *Widget {
            return &Widget{}
        }

        func (w *Widget) Render() string {
            return helper()
        }

        func helper() string {
            return "hi"
        }

        func Run() string {
            w := NewWidget()
            return w.Render()
        }

        func unusedHelper() string {
            return "never called"
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names
    assert "Render" not in dead_names
    assert "unusedHelper" in dead_names


def test_by_parent_propagation_is_scoped_to_framework_roots_not_every_reachable_class(tmp_path: Path):
    # Regression guard for a real bug found dogfooding Java: this rule
    # used to fire for *any* reachable class, marking every one of its
    # methods reachable unconditionally — including a genuinely unused
    # private helper on an ordinary, non-framework class, exactly the
    # pattern dead-code detection exists to catch. It must stay scoped to
    # classes registered via a framework convention (customElements.define
    # and friends), where a method really can be invoked with no call
    # edge anywhere in source.
    write(
        tmp_path / "a.ts",
        """
        export class Widget {
          used() { return 1; }
          neverCalled() { return 2; }
        }
        export function entry() {
          const w = new Widget();
          return w.used();
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "neverCalled" in dead_names
    assert "used" not in dead_names


def test_java_reachability_end_to_end(tmp_path: Path):
    write(
        tmp_path / "Widget.java",
        """
        public class Widget {
            public Widget() {}

            public static Widget create() {
                Widget w = new Widget();
                w.render();
                return w;
            }

            public String render() {
                return helper();
            }

            private String helper() {
                return "hi";
            }

            private String unusedHelper() {
                return "never called";
            }
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names
    assert "render" not in dead_names
    assert "unusedHelper" in dead_names


def test_rust_reachability_end_to_end(tmp_path: Path):
    write(
        tmp_path / "widget.rs",
        """
        pub struct Widget;

        impl Widget {
            pub fn new() -> Widget {
                Widget
            }

            pub fn render(&self) -> String {
                helper()
            }

            fn unused_helper(&self) -> String {
                String::from("never called")
            }
        }

        fn helper() -> String {
            String::from("hi")
        }

        pub fn run() -> String {
            let w = Widget::new();
            w.render()
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names
    assert "render" not in dead_names
    assert "unused_helper" in dead_names


def test_csharp_reachability_end_to_end(tmp_path: Path):
    write(
        tmp_path / "Widget.cs",
        """
        public class Widget {
            public Widget() {}

            public static Widget Create() {
                Widget w = new Widget();
                w.Render();
                return w;
            }

            public string Render() {
                return Helper();
            }

            private string Helper() {
                return "hi";
            }

            private string UnusedHelper() {
                return "never called";
            }
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "Helper" not in dead_names
    assert "Render" not in dead_names
    assert "UnusedHelper" in dead_names


def test_ruby_reachability_end_to_end(tmp_path: Path):
    write(
        tmp_path / "widget.rb",
        """
        class Widget
          def self.create
            w = Widget.new
            w.render
            w
          end

          def render
            helper
          end

          private

          def helper
            "hi"
          end

          def unused_helper
            "never called"
          end
        end
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names
    assert "render" not in dead_names
    assert "unused_helper" in dead_names


def test_php_reachability_end_to_end(tmp_path: Path):
    write(
        tmp_path / "widget.php",
        """
        <?php
        class Widget {
            public static function create() {
                $w = new Widget();
                $w->render();
                return $w;
            }

            public function render() {
                return $this->helper();
            }

            private function helper() {
                return "hi";
            }

            private function unusedHelper() {
                return "never called";
            }
        }
        """,
    )
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))

    conn = open_store(str(db))
    result = compute_dead_symbols(conn)
    dead_names = {s.name for s in result.dead}

    assert "helper" not in dead_names
    assert "render" not in dead_names
    assert "unusedHelper" in dead_names


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

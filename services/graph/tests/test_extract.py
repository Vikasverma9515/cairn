from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.ts"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_exported_function_declaration():
    result = parse("export function greet(name: string) { return hello(name); }")
    fn = next(s for s in result.symbols if s.name == "greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_finds_non_exported_function():
    result = parse("function helper() {}")
    fn = next(s for s in result.symbols if s.name == "helper")
    assert fn.exported is False


def test_finds_exported_arrow_const():
    result = parse('export const Comp = () => { return null; };')
    fn = next(s for s in result.symbols if s.name == "Comp")
    assert fn.kind == "arrow_const"
    assert fn.exported is True


def test_non_exported_arrow_const_is_not_exported():
    result = parse("const inner = () => 1;")
    fn = next(s for s in result.symbols if s.name == "inner")
    assert fn.exported is False


def test_finds_class_and_its_methods_with_correct_parent():
    result = parse(
        """
        export class Widget {
          render() { return greet("a"); }
          private helper() {}
        }
        """
    )
    cls = next(s for s in result.symbols if s.name == "Widget")
    assert cls.kind == "class"
    assert cls.exported is True

    render = next(s for s in result.symbols if s.name == "render")
    assert render.kind == "method"
    assert render.parent == "Widget"

    helper = next(s for s in result.symbols if s.name == "helper")
    assert helper.parent == "Widget"


def test_finds_interface_and_type_alias():
    result = parse(
        """
        export interface Props { name: string; }
        export type Alias = string;
        type Internal = number;
        """
    )
    props = next(s for s in result.symbols if s.name == "Props")
    assert props.kind == "interface"
    assert props.exported is True

    alias = next(s for s in result.symbols if s.name == "Alias")
    assert alias.kind == "type_alias"
    assert alias.exported is True

    internal = next(s for s in result.symbols if s.name == "Internal")
    assert internal.exported is False


def test_call_edges_capture_direct_and_member_calls_with_correct_caller():
    result = parse(
        """
        function outer() {
          inner();
          obj.method();
          this.doThing();
        }
        """
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "inner") in callees
    assert ("outer", "method") in callees
    assert ("outer", "doThing") in callees


def test_top_level_call_has_no_caller():
    result = parse("setup();")
    top_level = [c for c in result.calls if c.caller is None]
    assert any(c.callee == "setup" for c in top_level)


def test_imports_capture_source_and_named_bindings():
    result = parse('import { foo, bar as baz } from "./utils";')
    imp = result.imports[0]
    assert imp.source == "./utils"
    assert imp.is_relative is True
    assert set(imp.names) == {"foo", "baz"}  # aliased binding, not the original name


def test_import_relative_vs_package_detection():
    result = parse('import React from "react";\nimport { x } from "../shared";')
    by_source = {i.source: i for i in result.imports}
    assert by_source["react"].is_relative is False
    assert by_source["react"].names == ("React",)
    assert by_source["../shared"].is_relative is True


def test_default_export_function_still_gets_a_name():
    result = parse("export default function Page() { return null; }")
    page = next(s for s in result.symbols if s.name == "Page")
    assert page.kind == "function"


def test_tsx_file_parses_jsx_without_crashing():
    result = parse(
        """
        export function Button({ label }: { label: string }) {
          return <button onClick={() => handleClick()}>{label}</button>;
        }
        """,
        path="sample.tsx",
    )
    fn = next(s for s in result.symbols if s.name == "Button")
    assert fn.exported is True
    assert any(c.callee == "handleClick" for c in result.calls)


def test_unsupported_extension_returns_none_language():
    assert language_for_path("readme.md") is None


def test_custom_elements_define_marks_its_class_as_a_framework_root():
    result = parse(
        """
        class Widget extends HTMLElement {}
        customElements.define("my-widget", Widget);
        """
    )
    assert "Widget" in result.framework_roots


def test_unrelated_member_call_is_not_treated_as_a_framework_root():
    result = parse('console.log("Widget");')
    assert result.framework_roots == []

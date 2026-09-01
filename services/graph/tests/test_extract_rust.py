from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.rs"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_public_top_level_function():
    result = parse("pub fn greet(name: &str) -> String {\n    name.to_string()\n}\n")
    fn = next(s for s in result.symbols if s.name == "greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_private_function_is_not_exported():
    result = parse("fn helper() -> i32 {\n    1\n}\n")
    fn = next(s for s in result.symbols if s.name == "helper")
    assert fn.exported is False


def test_struct_gets_class_kind_and_correct_exported_flag():
    result = parse("pub struct Widget { name: String }\nstruct Internal;\n")
    widget = next(s for s in result.symbols if s.name == "Widget")
    assert widget.kind == "class"
    assert widget.exported is True

    internal = next(s for s in result.symbols if s.name == "Internal")
    assert internal.exported is False


def test_trait_gets_interface_kind():
    result = parse("pub trait Greeter {\n    fn greet(&self) -> String;\n}\n")
    trait = next(s for s in result.symbols if s.name == "Greeter")
    assert trait.kind == "interface"


def test_method_in_impl_block_gets_correct_kind_and_parent():
    result = parse(
        "pub struct Widget;\n\n"
        "impl Widget {\n"
        "    pub fn render(&self) -> String {\n"
        "        String::from(\"hi\")\n"
        "    }\n"
        "}\n"
    )
    method = next(s for s in result.symbols if s.name == "render")
    assert method.kind == "method"
    assert method.parent == "Widget"
    assert method.exported is True


def test_call_edges_capture_plain_associated_and_method_calls():
    result = parse(
        "pub struct Widget;\n\n"
        "fn caller() {\n"
        "    inner();\n"
        "    let w = Widget::new();\n"
        "    w.render();\n"
        "}\n\n"
        "fn inner() {}\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("caller", "inner") in callees
    assert ("caller", "new") in callees  # Widget::new() — associated function, last path segment
    assert ("caller", "render") in callees


def test_use_declaration_binds_the_last_segment_as_the_local_name():
    result = parse("use std::collections::HashMap;\n")
    imp = result.imports[0]
    assert imp.source == "std::collections::HashMap"
    assert imp.names == ("HashMap",)


def test_use_as_clause_binds_the_alias():
    result = parse("use std::collections::HashMap as Map;\n")
    imp = result.imports[0]
    assert imp.names == ("Map",)


def test_grouped_use_list_binds_each_item_separately():
    result = parse("use std::{fmt, io};\n")
    names = {i.names[0] for i in result.imports}
    assert names == {"fmt", "io"}


def test_use_wildcard_binds_no_name():
    result = parse("use std::fmt::*;\n")
    assert result.imports == []

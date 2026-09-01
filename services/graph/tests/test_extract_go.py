from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.go"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_exported_top_level_function():
    result = parse("package main\n\nfunc Greet(name string) string {\n\treturn name\n}\n")
    fn = next(s for s in result.symbols if s.name == "Greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_lowercase_function_is_not_exported():
    result = parse("package main\n\nfunc helper() int {\n\treturn 1\n}\n")
    fn = next(s for s in result.symbols if s.name == "helper")
    assert fn.exported is False


def test_struct_type_gets_class_kind_and_correct_exported_flag():
    result = parse("package main\n\ntype Widget struct {\n\tName string\n}\n\ntype internal struct{}\n")
    widget = next(s for s in result.symbols if s.name == "Widget")
    assert widget.kind == "class"
    assert widget.exported is True

    internal = next(s for s in result.symbols if s.name == "internal")
    assert internal.exported is False


def test_interface_type_gets_interface_kind():
    result = parse("package main\n\ntype Greeter interface {\n\tGreet() string\n}\n")
    iface = next(s for s in result.symbols if s.name == "Greeter")
    assert iface.kind == "interface"


def test_method_gets_correct_kind_and_parent_from_receiver():
    result = parse(
        "package main\n\n"
        "type Widget struct{}\n\n"
        "func (w *Widget) Render() string {\n\treturn w.Name\n}\n"
    )
    method = next(s for s in result.symbols if s.name == "Render")
    assert method.kind == "method"
    assert method.parent == "Widget"
    assert method.exported is True


def test_value_and_pointer_receiver_methods_share_the_same_parent():
    # A value receiver (w Widget) and a pointer receiver (w *Widget) on the
    # same type must resolve to the same parent name, or a struct's own
    # methods would split across "two classes" depending on which receiver
    # form each one happened to use.
    result = parse(
        "package main\n\n"
        "type Widget struct{}\n\n"
        "func (w Widget) A() {}\n"
        "func (w *Widget) B() {}\n"
    )
    a = next(s for s in result.symbols if s.name == "A")
    b = next(s for s in result.symbols if s.name == "B")
    assert a.parent == "Widget"
    assert b.parent == "Widget"


def test_call_edges_capture_plain_and_selector_calls():
    result = parse(
        "package main\n\n"
        "func outer() {\n"
        "\tinner()\n"
        "\tfmt.Println(\"hi\")\n"
        "\tw.Render()\n"
        "}\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "inner") in callees
    assert ("outer", "Println") in callees
    assert ("outer", "Render") in callees


def test_constructor_style_function_call_is_a_call_edge_with_no_separate_new_needed():
    # Go has no `new Widget()` syntax — NewWidget() is a plain function
    # call, already handled by the same call_expression path.
    result = parse(
        "package main\n\n"
        "type Widget struct{}\n\n"
        "func NewWidget() *Widget {\n\treturn &Widget{}\n}\n\n"
        "func setup() {\n\tw := NewWidget()\n\t_ = w\n}\n"
    )
    assert any(c.caller == "setup" and c.callee == "NewWidget" for c in result.calls)


def test_grouped_import_captures_default_and_aliased_names():
    result = parse('package main\n\nimport (\n\t"fmt"\n\tstr "strings"\n)\n')
    by_name = {i.names[0]: i for i in result.imports}
    assert by_name["fmt"].source == "fmt"
    assert by_name["fmt"].is_relative is False
    assert by_name["str"].source == "strings"


def test_single_import_uses_the_last_path_segment_as_the_default_name():
    result = parse('package main\n\nimport "net/http"\n')
    imp = result.imports[0]
    assert imp.source == "net/http"
    assert imp.names == ("http",)

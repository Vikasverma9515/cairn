from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.java"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_public_class():
    result = parse("public class Widget {}")
    cls = next(s for s in result.symbols if s.name == "Widget")
    assert cls.kind == "class"
    assert cls.exported is True


def test_package_private_class_is_not_exported():
    result = parse("class Internal {}")
    cls = next(s for s in result.symbols if s.name == "Internal")
    assert cls.exported is False


def test_interface_gets_interface_kind_and_implicitly_public_methods():
    result = parse("interface Greeter {\n    String greet();\n}\n")
    iface = next(s for s in result.symbols if s.name == "Greeter")
    assert iface.kind == "interface"

    method = next(s for s in result.symbols if s.name == "greet")
    assert method.exported is True  # no `public` keyword needed inside an interface
    assert method.parent == "Greeter"


def test_public_and_private_methods_get_correct_exported_flag_and_parent():
    result = parse(
        "public class Widget {\n"
        "    public String render() { return helper(); }\n"
        "    private String helper() { return \"x\"; }\n"
        "}\n"
    )
    render = next(s for s in result.symbols if s.name == "render")
    assert render.kind == "method"
    assert render.exported is True
    assert render.parent == "Widget"

    helper = next(s for s in result.symbols if s.name == "helper")
    assert helper.exported is False


def test_constructor_is_captured_as_a_method_named_after_the_class():
    result = parse("public class Widget {\n    public Widget(String name) {}\n}\n")
    ctor = next(s for s in result.symbols if s.name == "Widget" and s.kind == "method")
    assert ctor.parent == "Widget"
    assert ctor.exported is True


def test_call_edges_capture_plain_and_object_method_invocations():
    result = parse(
        "public class Widget {\n"
        "    public void outer() {\n"
        "        inner();\n"
        "        Math.max(1, 2);\n"
        "    }\n"
        "    private void inner() {}\n"
        "}\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "inner") in callees
    assert ("outer", "max") in callees


def test_object_creation_is_a_call_edge_reaching_the_class_and_its_constructor():
    result = parse(
        "public class Widget {\n"
        "    public Widget() {}\n"
        "    public static Widget create() {\n"
        "        return new Widget();\n"
        "    }\n"
        "}\n"
    )
    assert any(c.caller == "create" and c.callee == "Widget" for c in result.calls)


def test_import_captures_the_last_segment_as_the_local_name():
    result = parse("import java.util.List;\n")
    imp = result.imports[0]
    assert imp.source == "java.util.List"
    assert imp.names == ("List",)


def test_static_import_binds_the_member_name_with_the_class_as_source():
    result = parse("import static java.lang.Math.max;\n")
    imp = result.imports[0]
    assert imp.source == "java.lang.Math"
    assert imp.names == ("max",)


def test_wildcard_import_binds_no_name():
    result = parse("import java.util.*;\n")
    assert result.imports == []

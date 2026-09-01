from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.cs"):
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
    result = parse("interface IGreeter {\n    string Greet();\n}\n")
    iface = next(s for s in result.symbols if s.name == "IGreeter")
    assert iface.kind == "interface"

    method = next(s for s in result.symbols if s.name == "Greet")
    assert method.exported is True
    assert method.parent == "IGreeter"


def test_public_and_private_methods_get_correct_exported_flag_and_parent():
    result = parse(
        "public class Widget {\n"
        "    public string Render() { return Helper(); }\n"
        "    private string Helper() { return \"x\"; }\n"
        "}\n"
    )
    render = next(s for s in result.symbols if s.name == "Render")
    assert render.kind == "method"
    assert render.exported is True
    assert render.parent == "Widget"

    helper = next(s for s in result.symbols if s.name == "Helper")
    assert helper.exported is False


def test_constructor_is_captured_as_a_method_named_after_the_class():
    result = parse("public class Widget {\n    public Widget(string name) {}\n}\n")
    ctor = next(s for s in result.symbols if s.name == "Widget" and s.kind == "method")
    assert ctor.parent == "Widget"
    assert ctor.exported is True


def test_call_edges_capture_plain_and_member_invocations():
    result = parse(
        "public class Widget {\n"
        "    public void Outer() {\n"
        "        Inner();\n"
        "        Console.WriteLine(\"hi\");\n"
        "    }\n"
        "    private void Inner() {}\n"
        "}\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("Outer", "Inner") in callees
    assert ("Outer", "WriteLine") in callees


def test_object_creation_is_a_call_edge_reaching_the_class_and_its_constructor():
    result = parse(
        "public class Widget {\n"
        "    public Widget() {}\n"
        "    public static Widget Create() {\n"
        "        return new Widget();\n"
        "    }\n"
        "}\n"
    )
    assert any(c.caller == "Create" and c.callee == "Widget" for c in result.calls)


def test_using_directive_captures_the_last_segment_as_the_local_name():
    result = parse("using System.Collections.Generic;\n")
    imp = result.imports[0]
    assert imp.source == "System.Collections.Generic"
    assert imp.names == ("Generic",)


def test_using_alias_binds_the_alias_not_the_target():
    result = parse("using Utils = MyApp.Helpers.Utils;\n")
    imp = result.imports[0]
    assert imp.names == ("Utils",)
    assert imp.source == "MyApp.Helpers.Utils"


def test_simple_using_binds_the_bare_namespace():
    result = parse("using System;\n")
    imp = result.imports[0]
    assert imp.source == "System"
    assert imp.names == ("System",)

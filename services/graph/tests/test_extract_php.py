from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.php"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_top_level_function():
    result = parse("<?php\nfunction greet($name) {\n    return $name;\n}\n")
    fn = next(s for s in result.symbols if s.name == "greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_class_is_always_exported():
    result = parse("<?php\nclass Widget {}\n")
    cls = next(s for s in result.symbols if s.name == "Widget")
    assert cls.kind == "class"
    assert cls.exported is True


def test_interface_gets_interface_kind_and_implicitly_public_methods():
    result = parse("<?php\ninterface Greeter {\n    public function greet(): string;\n}\n")
    iface = next(s for s in result.symbols if s.name == "Greeter")
    assert iface.kind == "interface"

    method = next(s for s in result.symbols if s.name == "greet")
    assert method.exported is True
    assert method.parent == "Greeter"


def test_public_and_private_methods_get_correct_exported_flag_and_parent():
    result = parse(
        "<?php\nclass Widget {\n"
        "    public function render() { return $this->helper(); }\n"
        "    private function helper() { return 'x'; }\n"
        "}\n"
    )
    render = next(s for s in result.symbols if s.name == "render")
    assert render.kind == "method"
    assert render.exported is True
    assert render.parent == "Widget"

    helper = next(s for s in result.symbols if s.name == "helper")
    assert helper.exported is False


def test_method_with_no_visibility_keyword_defaults_to_public():
    result = parse("<?php\nclass Widget {\n    function implicit() {}\n}\n")
    method = next(s for s in result.symbols if s.name == "implicit")
    assert method.exported is True


def test_construct_is_always_exported_regardless_of_visibility():
    result = parse("<?php\nclass Widget {\n    private function __construct() {}\n}\n")
    ctor = next(s for s in result.symbols if s.name == "__construct")
    assert ctor.exported is True  # the engine calls this via `new`, not any code in the file


def test_call_edges_capture_plain_member_and_static_calls():
    result = parse(
        "<?php\nclass Widget {\n"
        "    public function outer() {\n"
        "        inner();\n"
        "        $this->render();\n"
        "        Widget::helper();\n"
        "    }\n"
        "    private function render() {}\n"
        "    private static function helper() {}\n"
        "}\n"
        "function inner() {}\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "inner") in callees
    assert ("outer", "render") in callees
    assert ("outer", "helper") in callees


def test_object_creation_is_a_call_edge_reaching_the_class():
    result = parse(
        "<?php\nclass Widget {\n"
        "    public static function create() {\n"
        "        return new Widget();\n"
        "    }\n"
        "}\n"
    )
    assert any(c.caller == "create" and c.callee == "Widget" for c in result.calls)


def test_use_captures_the_last_segment_as_the_local_name():
    result = parse("<?php\nuse App\\Utils\\Formatter;\n")
    imp = result.imports[0]
    assert imp.source == "App\\Utils\\Formatter"
    assert imp.names == ("Formatter",)


def test_use_alias_binds_the_alias_not_the_target():
    result = parse("<?php\nuse App\\Utils\\Helper as H;\n")
    imp = result.imports[0]
    assert imp.names == ("H",)
    assert imp.source == "App\\Utils\\Helper"

from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.py"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_public_top_level_function():
    result = parse("def greet(name):\n    return hello(name)\n")
    fn = next(s for s in result.symbols if s.name == "greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_leading_underscore_function_is_not_exported():
    result = parse("def _helper():\n    pass\n")
    fn = next(s for s in result.symbols if s.name == "_helper")
    assert fn.exported is False


def test_dunder_method_is_treated_as_exported_regardless_of_underscore():
    result = parse("class Widget:\n    def __init__(self):\n        pass\n")
    ctor = next(s for s in result.symbols if s.name == "__init__")
    assert ctor.exported is True  # the interpreter calls this, not this codebase's own code


def test_class_and_its_methods_get_correct_kind_and_parent():
    result = parse(
        "class Widget:\n"
        "    def render(self):\n"
        "        return greet('a')\n"
        "    def _helper(self):\n"
        "        pass\n"
    )
    cls = next(s for s in result.symbols if s.name == "Widget")
    assert cls.kind == "class"
    assert cls.exported is True

    render = next(s for s in result.symbols if s.name == "render")
    assert render.kind == "method"
    assert render.parent == "Widget"
    assert render.exported is True

    helper = next(s for s in result.symbols if s.name == "_helper")
    assert helper.exported is False


def test_call_edges_capture_plain_and_attribute_calls():
    result = parse(
        "def outer():\n"
        "    inner()\n"
        "    obj.method()\n"
        "    self.thing()\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "inner") in callees
    assert ("outer", "method") in callees
    assert ("outer", "thing") in callees


def test_class_instantiation_is_a_call_edge_with_no_separate_new_needed():
    # Python has no `new` keyword — Widget() *is* the call node, already
    # handled by the same path as a plain function call. Unlike JS/TS this
    # needs no separate new_expression handling.
    result = parse("def setup():\n    w = Widget()\n")
    assert any(c.caller == "setup" and c.callee == "Widget" for c in result.calls)


def test_plain_import_binds_top_level_segment():
    result = parse("import os\nimport numpy as np\n")
    by_name = {i.names[0]: i for i in result.imports}
    assert by_name["os"].source == "os"
    assert by_name["os"].is_relative is False
    assert by_name["np"].source == "numpy"


def test_from_import_captures_module_and_aliased_name():
    result = parse("from typing import Optional, List as PyList\n")
    by_name = {i.names[0]: i for i in result.imports}
    assert by_name["Optional"].source == "typing"
    assert by_name["PyList"].source == "typing"
    assert by_name["PyList"].is_relative is False


def test_relative_from_import_is_flagged_relative():
    result = parse("from .utils import helper\n")
    imp = result.imports[0]
    assert imp.source == ".utils"
    assert imp.is_relative is True
    assert imp.names == ("helper",)

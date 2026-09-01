from __future__ import annotations

from cairn_graph.extract import extract
from cairn_graph.languages import language_for_path, parser_for


def parse(source: str, path: str = "sample.rb"):
    spec = language_for_path(path)
    assert spec is not None, f"no grammar registered for {path}"
    parser = parser_for(spec)
    tree = parser.parse(source.encode("utf-8"))
    return extract(tree.root_node, source.encode("utf-8"), language=spec.id)


def test_finds_top_level_method_as_public_by_default():
    result = parse("def greet(name)\n  name\nend\n")
    fn = next(s for s in result.symbols if s.name == "greet")
    assert fn.kind == "function"
    assert fn.exported is True
    assert fn.parent is None


def test_class_gets_class_kind_and_is_always_exported():
    result = parse("class Widget\nend\n")
    cls = next(s for s in result.symbols if s.name == "Widget")
    assert cls.kind == "class"
    assert cls.exported is True


def test_methods_before_private_statement_are_public():
    result = parse(
        "class Widget\n"
        "  def render\n"
        "    helper\n"
        "  end\n"
        "\n"
        "  private\n"
        "\n"
        "  def helper\n"
        "    1\n"
        "  end\n"
        "end\n"
    )
    render = next(s for s in result.symbols if s.name == "render")
    helper = next(s for s in result.symbols if s.name == "helper")

    assert render.kind == "method"
    assert render.parent == "Widget"
    assert render.exported is True
    assert helper.exported is False


def test_public_statement_reverts_visibility_back_to_public():
    result = parse(
        "class Widget\n"
        "  private\n"
        "\n"
        "  def hidden\n"
        "  end\n"
        "\n"
        "  public\n"
        "\n"
        "  def visible\n"
        "  end\n"
        "end\n"
    )
    hidden = next(s for s in result.symbols if s.name == "hidden")
    visible = next(s for s in result.symbols if s.name == "visible")
    assert hidden.exported is False
    assert visible.exported is True


def test_visibility_resets_for_each_new_class():
    # A `private` statement in one class must not leak into a sibling
    # class's methods.
    result = parse(
        "class A\n"
        "  private\n"
        "  def a_hidden\n"
        "  end\n"
        "end\n"
        "\n"
        "class B\n"
        "  def b_visible\n"
        "  end\n"
        "end\n"
    )
    b_visible = next(s for s in result.symbols if s.name == "b_visible")
    assert b_visible.exported is True


def test_singleton_method_is_captured_with_module_as_parent():
    result = parse("module Utils\n  def self.greet\n    \"hi\"\n  end\nend\n")
    greet = next(s for s in result.symbols if s.name == "greet")
    assert greet.kind == "method"
    assert greet.parent == "Utils"


def test_call_edges_capture_dotted_calls():
    result = parse(
        "class Widget\n"
        "  def outer\n"
        "    Widget.new\n"
        "    obj.method_call\n"
        "  end\n"
        "end\n"
    )
    callees = {(c.caller, c.callee) for c in result.calls}
    assert ("outer", "new") in callees
    assert ("outer", "method_call") in callees


def test_bare_no_parens_call_is_a_reference_not_a_call_edge_and_is_not_duplicated():
    # Ruby's own grammar can't tell a bare `inner` (no parens, no
    # receiver) apart from a local-variable read without real semantic
    # analysis — tree-sitter-ruby parses it as a plain identifier, not a
    # `call` node. It still falls through to the general Reference
    # catch-all, so reachability sees it as used either way (calls and
    # references are unioned there) — this just documents that it's a
    # Reference here, not a CallEdge, and asserts it's captured exactly
    # once, not twice (a real duplicate-Reference bug found live: two
    # separate code paths inside the class-body walker both thought they
    # alone owned descending into a method's body).
    result = parse("class Widget\n  def outer\n    inner\n  end\n  def inner\n  end\nend\n")

    assert not any(c.callee == "inner" for c in result.calls)
    inner_refs = [r for r in result.references if r.name == "inner" and r.referrer == "outer"]
    assert len(inner_refs) == 1


def test_require_captures_the_gem_name_as_an_external_import():
    result = parse('require "json"\n')
    imp = result.imports[0]
    assert imp.source == "json"
    assert imp.is_relative is False


def test_require_relative_is_flagged_relative():
    result = parse('require_relative "./utils"\n')
    imp = result.imports[0]
    assert imp.source == "./utils"
    assert imp.is_relative is True


def test_require_is_not_also_recorded_as_a_call_edge():
    result = parse('require "json"\n')
    assert not any(c.callee == "require" for c in result.calls)

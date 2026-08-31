"""Walks one file's parse tree into symbols, imports, and call edges.

Call edges are name-based (the callee text as written — "foo" for foo(),
"method" for obj.method()), not fully type-resolved. That's a deliberate
scope cut, not an oversight: full type resolution needs a whole project's
type-checker loaded (what ts-morph already does, slowly, for one Next.js
app at a time) and doesn't survive to hundreds of thousands of files.
Name-based edges are exactly what proven tools in this class (CodeGraph,
the Meta SCARF lineage) use for reachability at scale — see the plan's
"dead code" section. A name-based edge can produce a false-positive
reachability link if two unrelated symbols share a name; it can never
produce a false negative that hides a real call, which is the safer
direction to be wrong in for a "don't tell the agent code is dead when
it's actually live" use case.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from tree_sitter import Node

_DECLARATION_EXPORT_PARENT = "export_statement"


@dataclass(frozen=True)
class Symbol:
    kind: str  # "function" | "class" | "method" | "interface" | "type_alias" | "arrow_const"
    name: str
    start_line: int  # 1-indexed
    end_line: int
    exported: bool
    parent: str | None  # enclosing class name, for methods; else None


@dataclass(frozen=True)
class ImportRecord:
    source: str  # module specifier as written, e.g. "./utils" or "react"
    names: tuple[str, ...]
    is_relative: bool
    line: int


@dataclass(frozen=True)
class CallEdge:
    caller: str | None  # enclosing symbol name, or None for module-top-level calls
    callee: str  # heuristic — the identifier as written, not type-resolved
    line: int


@dataclass
class ExtractResult:
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[ImportRecord] = field(default_factory=list)
    calls: list[CallEdge] = field(default_factory=list)


def extract(root: Node, source: bytes) -> ExtractResult:
    result = ExtractResult()
    _walk(root, source, result, enclosing=None)
    return result


def _text(node: Node, source: bytes) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _is_exported(node: Node) -> bool:
    parent = node.parent
    return parent is not None and parent.type == _DECLARATION_EXPORT_PARENT


def _walk(node: Node, source: bytes, out: ExtractResult, enclosing: str | None) -> None:
    next_enclosing = enclosing

    if node.type == "import_statement":
        _extract_import(node, source, out)
    elif node.type == "function_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            out.symbols.append(
                Symbol(
                    kind="function",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_is_exported(node),
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "method_definition":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            out.symbols.append(
                Symbol(
                    kind="method",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=False,  # methods aren't exported on their own — the class carries that
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "class_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            out.symbols.append(
                Symbol(
                    kind="class",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_is_exported(node),
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "interface_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            out.symbols.append(
                Symbol(
                    kind="interface",
                    name=_text(name_node, source),
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_is_exported(node),
                    parent=enclosing,
                )
            )
    elif node.type == "type_alias_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            out.symbols.append(
                Symbol(
                    kind="type_alias",
                    name=_text(name_node, source),
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_is_exported(node),
                    parent=enclosing,
                )
            )
    elif node.type == "variable_declarator":
        # `const foo = (...) => ...` / `const foo = function () {...}` —
        # arrow/function-expression consts are how most React components
        # and handlers are actually written, not `function` declarations.
        name_node = node.child_by_field_name("name")
        value_node = node.child_by_field_name("value")
        if name_node is not None and value_node is not None and value_node.type in ("arrow_function", "function_expression"):
            name = _text(name_node, source)
            declarator_export = node.parent is not None and node.parent.parent is not None and node.parent.parent.type == _DECLARATION_EXPORT_PARENT
            out.symbols.append(
                Symbol(
                    kind="arrow_const",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=declarator_export,
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "call_expression":
        callee = _callee_name(node, source)
        if callee is not None:
            out.calls.append(CallEdge(caller=enclosing, callee=callee, line=node.start_point[0] + 1))

    for child in node.children:
        _walk(child, source, out, next_enclosing)


def _callee_name(call_node: Node, source: bytes) -> str | None:
    fn = call_node.child_by_field_name("function")
    if fn is None:
        return None
    if fn.type == "identifier":
        return _text(fn, source)
    if fn.type == "member_expression":
        prop = fn.child_by_field_name("property")
        return _text(prop, source) if prop is not None else None
    return None


def _extract_import(node: Node, source: bytes, out: ExtractResult) -> None:
    source_node = node.child_by_field_name("source")
    if source_node is None:
        return
    module = _text(source_node, source).strip("\"'")
    names: list[str] = []
    clause = next((c for c in node.children if c.type == "import_clause"), None)
    if clause is not None:
        _collect_import_names(clause, source, names)
    out.imports.append(
        ImportRecord(
            source=module,
            names=tuple(names),
            is_relative=module.startswith(".") or module.startswith("/"),
            line=node.start_point[0] + 1,
        )
    )


def _collect_import_names(node: Node, source: bytes, out: list[str]) -> None:
    if node.type in ("import_specifier", "namespace_import"):
        # For `{ foo as bar }`, the local binding (`bar`) is what call
        # sites in *this* file actually use — prefer the alias field when
        # present, fall back to the specifier's own text otherwise.
        alias = node.child_by_field_name("alias")
        target = alias if alias is not None else node
        out.append(_text(target, source))
        return
    if node.type == "identifier" and node.parent is not None and node.parent.type == "import_clause":
        out.append(_text(node, source))  # default import
        return
    for child in node.children:
        _collect_import_names(child, source, out)

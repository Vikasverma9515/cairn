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


@dataclass(frozen=True)
class Reference:
    """A bare identifier used as a value or type, outside any call —
    `<Widget />` as JSX, `onClick={handler}` as a prop, `x: Status` as a
    type annotation, `.map(fn)` passing a function by name. Calls and
    instantiations are still tracked precisely as CallEdges (kept
    separate on purpose — that distinction matters for anything beyond
    reachability); this is the deliberately loose catch-all underneath
    them so reachability doesn't miss the many real ways a name gets used
    without ever being the callee of a call_expression/new_expression.
    Two known false-positive classes this was added specifically to fix
    — see reachability.py and the README's "Dead code detection" section
    for how each was found."""

    referrer: str | None  # enclosing symbol name, or None
    name: str
    line: int


@dataclass
class ExtractResult:
    symbols: list[Symbol] = field(default_factory=list)
    imports: list[ImportRecord] = field(default_factory=list)
    calls: list[CallEdge] = field(default_factory=list)
    # Names the *runtime*, not any code in this codebase, is what actually
    # invokes — found live: Cairn's own CairnWidgetElement is registered via
    # customElements.define("cairn-widget", CairnWidgetElement) and never
    # explicitly `new`'d anywhere; the browser instantiates it when the
    # custom element tag appears in HTML. No amount of call-edge tracking
    # inside the codebase can see that, so it's treated as its own
    # first-class signal — a narrow, explicit, growable list of known
    # framework-invocation conventions, not a guess. Same idea as the
    # existing Next.js indexer already special-casing _app.tsx/api routes
    # as "framework-invoked, not dead" instead of pretending pure static
    # analysis covers every runtime's calling convention.
    framework_roots: list[str] = field(default_factory=list)
    references: list[Reference] = field(default_factory=list)


def extract(root: Node, source: bytes, language: str = "typescript") -> ExtractResult:
    result = ExtractResult()
    # Positions (start_byte, end_byte) of every declaration's own name
    # node — must be excluded from reference collection, or every declared
    # symbol would trivially "reference itself" at its own declaration
    # site and nothing would ever read as dead again. Shared across both
    # walkers via the same result object's tracking, not a return value,
    # so each declaration branch can register its own name inline right
    # where it already extracts it.
    skip: set[tuple[int, int]] = set()
    # Split by grammar family rather than one dispatcher branching on every
    # node type: Python and JS/TS share some node *type names* ("call",
    # "import_statement") with completely different internal structure —
    # a single shared walker either has to disambiguate every such node by
    # language anyway (no real savings) or silently mishandles one
    # language's version of a name it wasn't written for.
    if language == "python":
        _walk_python(root, source, result, enclosing=None, skip=skip)
    else:
        _walk(root, source, result, enclosing=None, skip=skip)
    return result


def _text(node: Node, source: bytes) -> str:
    return source[node.start_byte : node.end_byte].decode("utf-8", errors="replace")


def _is_exported(node: Node) -> bool:
    parent = node.parent
    return parent is not None and parent.type == _DECLARATION_EXPORT_PARENT


def _walk(node: Node, source: bytes, out: ExtractResult, enclosing: str | None, skip: set[tuple[int, int]]) -> None:
    next_enclosing = enclosing

    if node.type == "import_statement":
        _extract_import(node, source, out)
    elif node.type == "function_declaration":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            skip.add((name_node.start_byte, name_node.end_byte))
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
            skip.add((name_node.start_byte, name_node.end_byte))
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
            skip.add((name_node.start_byte, name_node.end_byte))
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
            skip.add((name_node.start_byte, name_node.end_byte))
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
            skip.add((name_node.start_byte, name_node.end_byte))
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
            skip.add((name_node.start_byte, name_node.end_byte))
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
        _check_framework_root(node, source, out)
    elif node.type == "new_expression":
        # `new Widget()` is how every class actually gets used — missing
        # this meant a class's own constructor (and, transitively, every
        # method it calls) was invisible to reachability even when the
        # class was instantiated everywhere. Found live: dogfooding this
        # against Cairn's own web-component.ts flagged its constructor and
        # the whole buildDom()-and-everything-it-calls chain as "dead"
        # because `new CairnWidgetElement()` was the only thing invoking
        # it, and that was never captured as a call edge at all.
        ctor_node = node.child_by_field_name("constructor")
        if ctor_node is not None and ctor_node.type == "identifier":
            out.calls.append(CallEdge(caller=enclosing, callee="constructor", line=node.start_point[0] + 1))
            out.calls.append(CallEdge(caller=enclosing, callee=_text(ctor_node, source), line=node.start_point[0] + 1))
    elif node.type in ("identifier", "type_identifier", "property_identifier") and (node.start_byte, node.end_byte) not in skip:
        # The deliberately loose catch-all — see Reference's docstring.
        # Runs last so every more-precise branch above (which already
        # recorded its own name-node position in `skip`) takes priority;
        # this only fires for identifiers nothing else claimed.
        out.references.append(Reference(referrer=enclosing, name=_text(node, source), line=node.start_point[0] + 1))

    for child in node.children:
        _walk(child, source, out, next_enclosing, skip)


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


# Registered here, not inferred generically — each entry is a call whose
# *last* argument names a class the entry's runtime instantiates on its
# own. Expand this list as more real framework conventions are found
# (dogfooding is how the first one, customElements.define, was found);
# don't try to guess every framework's convention up front.
_FRAMEWORK_REGISTRATION_CALLS = {"customElements.define"}


def _check_framework_root(call_node: Node, source: bytes, out: ExtractResult) -> None:
    fn = call_node.child_by_field_name("function")
    if fn is None or fn.type != "member_expression":
        return
    full_callee = _text(fn, source)
    if full_callee not in _FRAMEWORK_REGISTRATION_CALLS:
        return
    args = call_node.child_by_field_name("arguments")
    if args is None:
        return
    arg_nodes = [c for c in args.children if c.type not in ("(", ")", ",")]
    if not arg_nodes:
        return
    last_arg = arg_nodes[-1]
    if last_arg.type == "identifier":
        out.framework_roots.append(_text(last_arg, source))


def _py_is_public(name: str) -> bool:
    # The actual Python convention for "this is exported" — there's no
    # `export` keyword, a single leading underscore is the idiomatic
    # signal for "module-private". Dunder methods (__init__, __str__, ...)
    # are the interpreter's own object protocol calling them, not this
    # codebase's code — same category as a Web Component's
    # connectedCallback, so they're always reachable too, not just
    # "public" in the module-boundary sense.
    return not name.startswith("_") or (name.startswith("__") and name.endswith("__"))


def _walk_python(node: Node, source: bytes, out: ExtractResult, enclosing: str | None, skip: set[tuple[int, int]]) -> None:
    next_enclosing = enclosing

    if node.type in ("import_statement", "import_from_statement"):
        _extract_python_import(node, source, out)
    elif node.type == "function_definition":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            skip.add((name_node.start_byte, name_node.end_byte))
            out.symbols.append(
                Symbol(
                    kind="method" if enclosing is not None else "function",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_py_is_public(name),
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "class_definition":
        name_node = node.child_by_field_name("name")
        if name_node is not None:
            name = _text(name_node, source)
            skip.add((name_node.start_byte, name_node.end_byte))
            out.symbols.append(
                Symbol(
                    kind="class",
                    name=name,
                    start_line=node.start_point[0] + 1,
                    end_line=node.end_point[0] + 1,
                    exported=_py_is_public(name),
                    parent=enclosing,
                )
            )
            next_enclosing = name
    elif node.type == "call":
        callee = _py_callee_name(node, source)
        if callee is not None:
            out.calls.append(CallEdge(caller=enclosing, callee=callee, line=node.start_point[0] + 1))
    elif node.type == "identifier" and (node.start_byte, node.end_byte) not in skip:
        # Same deliberately loose catch-all as the JS/TS walker — see
        # Reference's docstring. Python has no separate "type_identifier"/
        # "property_identifier" node types; a member-access property and a
        # plain name are both just "identifier" here.
        out.references.append(Reference(referrer=enclosing, name=_text(node, source), line=node.start_point[0] + 1))

    for child in node.children:
        _walk_python(child, source, out, next_enclosing, skip)


def _py_callee_name(call_node: Node, source: bytes) -> str | None:
    fn = call_node.child_by_field_name("function")
    if fn is None:
        return None
    if fn.type == "identifier":
        return _text(fn, source)  # covers both a plain call and `Widget()` instantiation — Python has no separate `new`
    if fn.type == "attribute":
        attr = fn.child_by_field_name("attribute")
        return _text(attr, source) if attr is not None else None
    return None


def _extract_python_import(node: Node, source: bytes, out: ExtractResult) -> None:
    module_name_node = node.child_by_field_name("module_name")  # only set on import_from_statement
    module_text = _text(module_name_node, source) if module_name_node is not None else None
    is_relative = module_text is not None and module_text.startswith(".")
    line = node.start_point[0] + 1

    for child in node.children:
        if child is module_name_node:
            continue  # the module itself, not a bound name — only present on import_from_statement
        if child.type == "dotted_name":
            # Plain `import foo.bar` binds the top-level segment (`foo`)
            # into scope, not the full dotted path.
            local_name = _text(child, source).split(".")[0]
            out.imports.append(ImportRecord(source=module_text or _text(child, source), names=(local_name,), is_relative=is_relative, line=line))
        elif child.type == "aliased_import":
            dotted = child.child_by_field_name("name")
            alias = child.child_by_field_name("alias")
            local_name = _text(alias, source) if alias is not None else (_text(dotted, source).split(".")[0] if dotted is not None else None)
            if local_name is not None:
                source_text = module_text or (_text(dotted, source) if dotted is not None else local_name)
                out.imports.append(ImportRecord(source=source_text, names=(local_name,), is_relative=is_relative, line=line))


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

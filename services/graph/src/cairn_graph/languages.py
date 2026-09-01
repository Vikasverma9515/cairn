"""Maps a file to the tree-sitter grammar that parses it.

Deliberately one PyPI package per language (tree-sitter-typescript,
tree-sitter-javascript, ...) rather than a bundle like
tree-sitter-language-pack: that package fetches grammar binaries from a
GitHub release manifest the first time each language is used, which is a
real, hard blocker for an on-prem/air-gapped install — confirmed live
(DownloadError, connection reset) while building this. Each grammar here
compiles into its package's wheel at install time; nothing is fetched at
runtime, ever.
"""

from __future__ import annotations

from dataclasses import dataclass

import tree_sitter_go as tsgo
import tree_sitter_java as tsjava
import tree_sitter_javascript as tsjs
import tree_sitter_python as tspy
import tree_sitter_rust as tsrust
import tree_sitter_typescript as tsts
from tree_sitter import Language, Parser

# Kept distinct from Cairn's `ui-manifest.json` idea of "language" — this is
# the tree-sitter grammar name a file's parse tree came from, used for
# per-language extraction rules (extract.py branches on this).
LanguageId = str


@dataclass(frozen=True)
class LanguageSpec:
    id: LanguageId
    language: Language


_TYPESCRIPT = LanguageSpec("typescript", Language(tsts.language_typescript()))
_TSX = LanguageSpec("tsx", Language(tsts.language_tsx()))
_JAVASCRIPT = LanguageSpec("javascript", Language(tsjs.language()))
_PYTHON = LanguageSpec("python", Language(tspy.language()))
_GO = LanguageSpec("go", Language(tsgo.language()))
_JAVA = LanguageSpec("java", Language(tsjava.language()))
_RUST = LanguageSpec("rust", Language(tsrust.language()))

# Extension -> language, longest/most-specific match first where it matters
# (.tsx must not fall through to plain typescript, which can't parse JSX).
_EXTENSION_MAP: dict[str, LanguageSpec] = {
    ".ts": _TYPESCRIPT,
    ".mts": _TYPESCRIPT,
    ".cts": _TYPESCRIPT,
    ".tsx": _TSX,
    ".js": _JAVASCRIPT,
    ".mjs": _JAVASCRIPT,
    ".cjs": _JAVASCRIPT,
    ".jsx": _JAVASCRIPT,
    ".py": _PYTHON,
    ".pyi": _PYTHON,
    ".go": _GO,
    ".java": _JAVA,
    ".rs": _RUST,
}

_PARSER_CACHE: dict[LanguageId, Parser] = {}


def language_for_path(path: str) -> LanguageSpec | None:
    for ext, spec in _EXTENSION_MAP.items():
        if path.endswith(ext):
            return spec
    return None


def parser_for(spec: LanguageSpec) -> Parser:
    """Parser objects aren't safe to share across processes (each worker
    process gets its own via this cache), but are cheap to reuse within
    one — avoids re-constructing a Parser per file in a hot loop."""
    cached = _PARSER_CACHE.get(spec.id)
    if cached is not None:
        return cached
    parser = Parser(spec.language)
    _PARSER_CACHE[spec.id] = parser
    return parser


def supported_extensions() -> tuple[str, ...]:
    return tuple(_EXTENSION_MAP.keys())

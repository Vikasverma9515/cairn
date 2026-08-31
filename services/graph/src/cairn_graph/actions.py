"""The permission gate — Month 2's first slice, and the mechanism behind
pillar 4 of the platform-operator plan: an agent that can act on the
codebase, but asks first when the action is critical, and can be run in
either "auto mode" (safe/reversible actions proceed, critical ones still
stop and ask) or "review mode" (everything stops and asks).

This module owns exactly two things: classifying an action's risk, and
deciding whether that risk clears a given mode. It does not own the
approval UX itself (a popup, a chat prompt) — that's the orchestrator's
job, one layer up. What this module guarantees is that the *decision* is
made the same way every time, for every tool, instead of each tool author
reinventing "is this one safe to just do."

Precedent: this mirrors the three-tier shape Claude Code's own tool
permissions already use (auto-allowed, ask-first, never-without-explicit-
request) — CRITICAL here is deliberately the same category as this
agent's own "Prohibited"/"Explicit permission required" action lists:
hard to reverse, or affects something beyond the one file being edited.
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass
from enum import Enum

_OUTPUT_CAP = 10_000  # chars — enough to be useful, not enough for a runaway process to flood the response


class RiskTier(str, Enum):
    SAFE = "safe"  # read-only — always proceeds, in either mode
    REVIEW = "review"  # mutating, but scoped and reversible (e.g. a single-file text edit)
    CRITICAL = "critical"  # destructive or hard to reverse (delete, shell exec, anything outside the indexed root)


class PermissionMode(str, Enum):
    AUTO = "auto"
    REVIEW = "review"


class Decision(str, Enum):
    ALLOW = "allow"
    NEEDS_APPROVAL = "needs_approval"


@dataclass
class ActionRequest:
    tool_name: str
    description: str
    risk: RiskTier
    args: dict


def decide(action: ActionRequest, mode: PermissionMode) -> Decision:
    """The one rule this whole module exists to enforce: CRITICAL always
    stops, regardless of mode. SAFE never stops. REVIEW stops only in
    review mode — that's the entire difference between the two modes."""
    if action.risk is RiskTier.CRITICAL:
        return Decision.NEEDS_APPROVAL
    if action.risk is RiskTier.SAFE:
        return Decision.ALLOW
    # RiskTier.REVIEW
    return Decision.NEEDS_APPROVAL if mode is PermissionMode.REVIEW else Decision.ALLOW


class PathEscapesRootError(ValueError):
    pass


def _resolve_within_root(root: str, file_path: str) -> str:
    """A single-file text edit is only REVIEW-tier because it's scoped to
    the indexed repo. Without this check, a `file_path` of
    `../../../etc/hosts` would make that scoping a lie."""
    root_real = os.path.realpath(root)
    target_real = os.path.realpath(os.path.join(root, file_path))
    if os.path.commonpath([root_real, target_real]) != root_real:
        raise PathEscapesRootError(f"{file_path!r} resolves outside the indexed root {root!r}")
    return target_real


def build_apply_edit_action(root: str, file_path: str, old_text: str, new_text: str) -> ActionRequest:
    _resolve_within_root(root, file_path)  # raises before an ActionRequest is even constructed
    return ActionRequest(
        tool_name="apply_edit",
        description=f"Replace one occurrence of {len(old_text)} char(s) with {len(new_text)} char(s) in {file_path}",
        risk=RiskTier.REVIEW,
        args={"file_path": file_path, "old_text": old_text, "new_text": new_text},
    )


class EditNotUniqueError(ValueError):
    pass


def apply_edit(root: str, file_path: str, old_text: str, new_text: str) -> dict:
    """Same semantics as this agent's own Edit tool: old_text must match
    exactly once, or the edit is refused rather than guessed at. Actually
    touches disk — callers must have already cleared this through
    `decide()` before calling it."""
    target = _resolve_within_root(root, file_path)
    content = open(target, encoding="utf-8").read()
    count = content.count(old_text)
    if count == 0:
        raise EditNotUniqueError(f"old_text not found in {file_path}")
    if count > 1:
        raise EditNotUniqueError(f"old_text matches {count} times in {file_path}; must match exactly once")
    with open(target, "w", encoding="utf-8") as f:
        f.write(content.replace(old_text, new_text, 1))
    return {"file_path": file_path, "bytes_written": len(content) - len(old_text) + len(new_text)}


def build_run_command_action(command: list[str]) -> ActionRequest:
    """Arbitrary command execution is the textbook CRITICAL action — no
    scoping check can make "run whatever this string says" reversible or
    contained the way a single-file text edit is. It always needs
    approval (see `decide()`); this exists so the tier isn't just a name
    with nothing behind it."""
    if not command:
        raise ValueError("command must not be empty")
    return ActionRequest(
        tool_name="run_command",
        description=f"Run: {' '.join(command)}",
        risk=RiskTier.CRITICAL,
        args={"command": command},
    )


def run_command(root: str, command: list[str], timeout: int = 30) -> dict:
    """Runs with cwd pinned to the indexed root and shell=False — argv
    form only, no shell string interpolation. Approval is enforced by the
    caller (via `decide()`); this function trusts that it was already
    cleared, same contract as `apply_edit`."""
    if not command:
        raise ValueError("command must not be empty")
    try:
        proc = subprocess.run(command, cwd=root, capture_output=True, text=True, timeout=timeout, shell=False)
    except subprocess.TimeoutExpired as exc:
        return {"timed_out": True, "returncode": None, "stdout": (exc.stdout or "")[:_OUTPUT_CAP], "stderr": (exc.stderr or "")[:_OUTPUT_CAP]}
    return {
        "timed_out": False,
        "returncode": proc.returncode,
        "stdout": proc.stdout[:_OUTPUT_CAP],
        "stderr": proc.stderr[:_OUTPUT_CAP],
    }

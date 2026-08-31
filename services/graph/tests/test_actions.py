from __future__ import annotations

from pathlib import Path

import pytest

from cairn_graph.actions import (
    ActionRequest,
    Decision,
    EditNotUniqueError,
    PathEscapesRootError,
    PermissionMode,
    RiskTier,
    apply_edit,
    build_apply_edit_action,
    build_run_command_action,
    decide,
    run_command,
)


def test_safe_action_is_always_allowed_regardless_of_mode():
    action = ActionRequest("search", "read-only lookup", RiskTier.SAFE, {})
    assert decide(action, PermissionMode.AUTO) is Decision.ALLOW
    assert decide(action, PermissionMode.REVIEW) is Decision.ALLOW


def test_critical_action_always_needs_approval_regardless_of_mode():
    action = ActionRequest("run_shell", "rm -rf something", RiskTier.CRITICAL, {})
    assert decide(action, PermissionMode.AUTO) is Decision.NEEDS_APPROVAL
    assert decide(action, PermissionMode.REVIEW) is Decision.NEEDS_APPROVAL


def test_review_action_is_allowed_in_auto_mode_but_needs_approval_in_review_mode():
    action = ActionRequest("apply_edit", "edit a file", RiskTier.REVIEW, {})
    assert decide(action, PermissionMode.AUTO) is Decision.ALLOW
    assert decide(action, PermissionMode.REVIEW) is Decision.NEEDS_APPROVAL


def test_build_apply_edit_action_rejects_a_path_that_escapes_the_root(tmp_path: Path):
    with pytest.raises(PathEscapesRootError):
        build_apply_edit_action(str(tmp_path), "../../etc/hosts", "a", "b")


def test_apply_edit_replaces_the_unique_match(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("function greet() { return 'hi'; }")

    result = apply_edit(str(tmp_path), "a.ts", "'hi'", "'hello'")

    assert f.read_text() == "function greet() { return 'hello'; }"
    assert result["file_path"] == "a.ts"


def test_apply_edit_refuses_when_old_text_is_missing(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("function greet() { return 'hi'; }")

    with pytest.raises(EditNotUniqueError):
        apply_edit(str(tmp_path), "a.ts", "not present", "x")

    assert f.read_text() == "function greet() { return 'hi'; }"  # untouched


def test_apply_edit_refuses_when_old_text_is_ambiguous(tmp_path: Path):
    f = tmp_path / "a.ts"
    f.write_text("const a = 1;\nconst b = 1;")

    with pytest.raises(EditNotUniqueError):
        apply_edit(str(tmp_path), "a.ts", "= 1", "= 2")

    assert f.read_text() == "const a = 1;\nconst b = 1;"  # untouched


def test_apply_edit_refuses_a_path_that_escapes_the_root(tmp_path: Path):
    outside = tmp_path.parent / "outside.txt"
    outside.write_text("secret")
    root = tmp_path / "repo"
    root.mkdir()

    with pytest.raises(PathEscapesRootError):
        apply_edit(str(root), "../outside.txt", "secret", "leaked")

    assert outside.read_text() == "secret"  # untouched


def test_build_run_command_action_is_always_critical_tier():
    action = build_run_command_action(["echo", "hi"])
    assert action.risk is RiskTier.CRITICAL


def test_build_run_command_action_rejects_empty_command():
    with pytest.raises(ValueError):
        build_run_command_action([])


def test_run_command_always_needs_approval_in_either_mode():
    action = build_run_command_action(["echo", "hi"])
    assert decide(action, PermissionMode.AUTO) is Decision.NEEDS_APPROVAL
    assert decide(action, PermissionMode.REVIEW) is Decision.NEEDS_APPROVAL


def test_run_command_executes_with_cwd_pinned_to_root(tmp_path: Path):
    (tmp_path / "marker.txt").write_text("present")

    result = run_command(str(tmp_path), ["ls", "marker.txt"])

    assert result["returncode"] == 0
    assert "marker.txt" in result["stdout"]
    assert result["timed_out"] is False


def test_run_command_captures_nonzero_exit_and_stderr(tmp_path: Path):
    result = run_command(str(tmp_path), ["ls", "does-not-exist.txt"])

    assert result["returncode"] != 0
    assert result["stderr"] != ""


def test_run_command_times_out_instead_of_hanging(tmp_path: Path):
    result = run_command(str(tmp_path), ["sleep", "5"], timeout=1)

    assert result["timed_out"] is True

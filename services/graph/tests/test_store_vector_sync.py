from __future__ import annotations

from pathlib import Path

from cairn_graph.store import get_vector_sync_state, open_store, remove_vector_sync_state, set_vector_sync_state


def test_set_then_get_vector_sync_state(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    set_vector_sync_state(conn, "a.ts", "hash1")

    assert get_vector_sync_state(conn) == {"a.ts": "hash1"}


def test_set_vector_sync_state_upserts_rather_than_accumulating(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    set_vector_sync_state(conn, "a.ts", "hash1")
    set_vector_sync_state(conn, "a.ts", "hash2")

    assert get_vector_sync_state(conn) == {"a.ts": "hash2"}


def test_remove_vector_sync_state(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    set_vector_sync_state(conn, "a.ts", "hash1")
    remove_vector_sync_state(conn, "a.ts")

    assert get_vector_sync_state(conn) == {}


def test_get_vector_sync_state_with_no_data_is_empty(tmp_path: Path):
    conn = open_store(str(tmp_path / "g.db"))
    assert get_vector_sync_state(conn) == {}

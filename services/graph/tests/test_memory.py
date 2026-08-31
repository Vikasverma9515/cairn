from __future__ import annotations

from pathlib import Path

from cairn_graph.memory import forget, open_memory_store, recall, record_turn, recent_history, remember


def test_remember_then_recall_a_single_key(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    remember(conn, "acme", "permission_mode", "auto")

    assert recall(conn, "acme", "permission_mode") == {"permission_mode": "auto"}


def test_recall_with_no_key_returns_every_fact(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    remember(conn, "acme", "permission_mode", "auto")
    remember(conn, "acme", "framework", "nextjs")

    facts = recall(conn, "acme")

    assert facts == {"permission_mode": "auto", "framework": "nextjs"}


def test_recall_for_unknown_key_returns_empty_dict(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    assert recall(conn, "acme", "nope") == {}


def test_remember_upserts_rather_than_accumulating(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    remember(conn, "acme", "permission_mode", "review")
    remember(conn, "acme", "permission_mode", "auto")

    facts = recall(conn, "acme")

    assert facts == {"permission_mode": "auto"}  # one current value, not two rows


def test_memory_is_scoped_per_customer(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    remember(conn, "acme", "framework", "nextjs")
    remember(conn, "globex", "framework", "vue")

    assert recall(conn, "acme") == {"framework": "nextjs"}
    assert recall(conn, "globex") == {"framework": "vue"}


def test_forget_removes_a_fact(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    remember(conn, "acme", "framework", "nextjs")
    forget(conn, "acme", "framework")

    assert recall(conn, "acme") == {}


def test_record_turn_and_recent_history_returns_oldest_first(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    record_turn(conn, "acme", "user", "delete the scratch file")
    record_turn(conn, "acme", "assistant", "that needs approval")

    history = recent_history(conn, "acme")

    assert [t.content for t in history] == ["delete the scratch file", "that needs approval"]
    assert history[0].role == "user"


def test_recent_history_respects_limit_and_still_returns_oldest_first(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    for i in range(5):
        record_turn(conn, "acme", "user", f"turn {i}")

    history = recent_history(conn, "acme", limit=2)

    assert [t.content for t in history] == ["turn 3", "turn 4"]


def test_conversation_history_is_scoped_per_customer(tmp_path: Path):
    conn = open_memory_store(str(tmp_path / "m.db"))
    record_turn(conn, "acme", "user", "acme's message")
    record_turn(conn, "globex", "user", "globex's message")

    assert [t.content for t in recent_history(conn, "acme")] == ["acme's message"]
    assert [t.content for t in recent_history(conn, "globex")] == ["globex's message"]

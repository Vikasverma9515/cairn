from __future__ import annotations

from pathlib import Path

from cairn_graph.build import build_graph
from cairn_graph.dashboard import assemble_dashboard_data, generate_narrative, render_dashboard_html
from cairn_graph.memory import open_memory_store, record_turn
from cairn_graph.store import log_action, open_store


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


class _FakeLLMProvider:
    def __init__(self, reply: str = "This looks like a small internal tool."):
        self._reply = reply
        self.last_prompt = None
        self.last_system = None

    def complete(self, prompt: str, *, system: str | None = None) -> str:
        self.last_prompt = prompt
        self.last_system = system
        return self._reply


def _built(tmp_path: Path):
    write(tmp_path / "a.ts", 'import { helper } from "./b";\nexport function fromA() { return helper(); }')
    write(tmp_path / "b.ts", "export function helper() { return 1; }")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))
    conn = open_store(str(db))
    memory_conn = open_memory_store(str(tmp_path / "memory.db"))
    return conn, memory_conn


def test_assemble_dashboard_data_includes_real_index_stats(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    data = assemble_dashboard_data(conn, memory_conn)
    assert data.index_stats["files"] == 2
    assert data.customer_id is None


def test_assemble_dashboard_data_scoped_to_one_customer_includes_their_history(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    record_turn(memory_conn, "acme", "user", "delete the old file")
    record_turn(memory_conn, "acme", "assistant", "that needs approval")

    data = assemble_dashboard_data(conn, memory_conn, customer_id="acme")

    assert data.customer_id == "acme"
    assert [t["content"] for t in data.recent_conversation] == ["delete the old file", "that needs approval"]
    assert data.customers == []  # company-wide roster only makes sense unscoped


def test_assemble_dashboard_data_includes_action_summary_and_dependency_summary(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    log_action(conn, "apply_edit", "x", "review", "applied")

    data = assemble_dashboard_data(conn, memory_conn)

    assert data.action_summary["total_actions"] == 1
    assert data.dependency_summary["cycle_count"] == 0


def test_generate_narrative_passes_real_grounded_data_to_the_provider(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    log_action(conn, "apply_edit", "x", "review", "applied")
    data = assemble_dashboard_data(conn, memory_conn)

    fake = _FakeLLMProvider("A small TypeScript utility library.")
    narrative = generate_narrative(data, fake)

    assert narrative == "A small TypeScript utility library."
    assert "2 files" in fake.last_prompt or "files" in fake.last_prompt
    assert "apply_edit" in fake.last_prompt
    assert fake.last_system is not None and "never invent" in fake.last_system


def test_generate_narrative_includes_real_conversation_text_when_scoped(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    record_turn(memory_conn, "acme", "user", "why is this file so complicated")
    data = assemble_dashboard_data(conn, memory_conn, customer_id="acme")

    fake = _FakeLLMProvider()
    generate_narrative(data, fake)

    assert "why is this file so complicated" in fake.last_prompt


def test_render_dashboard_html_includes_the_narrative_and_stats(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    data = assemble_dashboard_data(conn, memory_conn)

    html = render_dashboard_html(data, "A grounded narrative sentence.", title="Test Dashboard")

    assert "Test Dashboard" in html
    assert "A grounded narrative sentence." in html
    assert "<title>Test Dashboard</title>" in html


def test_render_dashboard_html_escapes_untrusted_text(tmp_path: Path):
    conn, memory_conn = _built(tmp_path)
    data = assemble_dashboard_data(conn, memory_conn)

    html = render_dashboard_html(data, "<script>alert(1)</script>", title="Test")

    assert "<script>alert(1)</script>" not in html
    assert "&lt;script&gt;" in html


def test_render_dashboard_html_handles_empty_data_gracefully(tmp_path: Path):
    write(tmp_path / "empty.txt", "not code")
    db = tmp_path / "graph.db"
    build_graph(str(tmp_path), str(db))
    conn = open_store(str(db))
    memory_conn = open_memory_store(str(tmp_path / "memory.db"))
    data = assemble_dashboard_data(conn, memory_conn)

    html = render_dashboard_html(data, "No activity yet.")

    assert "No activity recorded yet." in html
    assert "No tool usage recorded yet." in html

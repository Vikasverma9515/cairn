"use client";

import { useState } from "react";
import type { BoardCard, BoardColumn } from "../lib/board-types";
import { CardModal } from "./CardModal";

// The "kanban" primitive's real UI — real columns, real cards, a real move
// between them. Move is a <select> (onChange, not a drag gesture) for the
// same reason the workflow canvas favors explicit connect actions: it's a
// real state transition an agent can target directly, without needing
// pointer-drag simulation.
export function BoardColumns({ columns }: { columns: BoardColumn[] }) {
  const [editingCard, setEditingCard] = useState<BoardCard | null>(null);
  const [newCardTitle, setNewCardTitle] = useState<Record<string, string>>({});

  async function handleMove(cardId: string, toColumnId: string) {
    if (!toColumnId) return;
    await fetch(`/api/board/cards/${cardId}/move`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ toColumnId }),
    });
    window.location.reload();
  }

  async function handleAddCard(columnId: string) {
    const title = (newCardTitle[columnId] ?? "").trim();
    if (!title) return;
    await fetch("/api/board/cards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ columnId, title }),
    });
    window.location.reload();
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3" data-ai="board-columns">
      {columns.map((column) => (
        <div key={column.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{column.title}</h2>
          <div className="mt-3 flex flex-col gap-2">
            {column.cards.map((card) => (
              <div key={card.id} className="rounded-lg border border-gray-200 bg-gray-50 p-3" data-ai={`board-card-${card.id}`}>
                <div className="text-sm font-medium text-gray-800">{card.title}</div>
                {card.description && <div className="mt-1 text-xs text-gray-500">{card.description}</div>}
                <div className="mt-2 flex items-center gap-2">
                  <select
                    data-ai={`board-move-${card.id}`}
                    value=""
                    onChange={(e) => handleMove(card.id, e.target.value)}
                    className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700"
                  >
                    <option value="">Move to…</option>
                    {columns.filter((c) => c.id !== column.id).map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                  <button
                    data-ai={`board-edit-${card.id}`}
                    onClick={() => setEditingCard(card)}
                    className="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100"
                  >
                    Edit
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <input
              data-ai={`board-new-card-title-${column.id}`}
              value={newCardTitle[column.id] ?? ""}
              onChange={(e) => setNewCardTitle((prev) => ({ ...prev, [column.id]: e.target.value }))}
              placeholder="New card…"
              className="w-full rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-800"
            />
            <button
              data-ai={`board-add-card-${column.id}`}
              onClick={() => handleAddCard(column.id)}
              className="whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs font-medium text-white hover:bg-gray-800"
            >
              Add
            </button>
          </div>
        </div>
      ))}
      {editingCard && <CardModal card={editingCard} onClose={() => setEditingCard(null)} />}
    </div>
  );
}

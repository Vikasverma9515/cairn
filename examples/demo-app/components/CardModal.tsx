"use client";

import { useState } from "react";
import type { BoardCard } from "../lib/board-types";

// The "modal" primitive's real UI — a dynamically-rendered dialog opened
// from a board card, not an inline edit. Real content-ops: editing a
// card's title/description persists through /api/board/cards/[id].
export function CardModal({ card, onClose }: { card: BoardCard; onClose: () => void }) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    await fetch(`/api/board/cards/${card.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, description }),
    });
    window.location.reload();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" data-ai="board-modal">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h2 className="text-lg font-semibold text-gray-900">Edit card</h2>
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-gray-500">Title</label>
        <input
          data-ai="board-modal-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
        />
        <label className="mt-4 block text-xs font-medium uppercase tracking-wide text-gray-500">Description</label>
        <textarea
          data-ai="board-modal-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button
            data-ai="board-modal-close"
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100"
          >
            Close
          </button>
          <button
            data-ai="board-modal-save"
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-60"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

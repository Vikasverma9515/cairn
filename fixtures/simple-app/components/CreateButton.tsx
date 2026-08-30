"use client";

export function CreateButton() {
  async function handleCreate() {
    await fetch("/api/items", { method: "POST" });
  }

  return (
    <button data-ai="create-item" onClick={handleCreate}>
      Create Item
    </button>
  );
}

// A real kanban board, persisted in SQLite (lib/db.ts) — the "kanban" and
// "modal" primitives' backing data, same real-CRUD convention as
// invoices.ts/workflows.ts. Server-only (imports db.ts) — see
// board-types.ts for what a "use client" component may import instead.
import { db } from "./db";
import { COLUMN_ORDER, type BoardCard, type BoardColumn } from "./board-types";

seedIfEmpty();

export function listBoard(): BoardColumn[] {
  const columns = db.prepare("SELECT id, title FROM board_columns ORDER BY position ASC").all() as { id: string; title: string }[];
  const cards = db.prepare("SELECT id, column_id, title, description FROM board_cards ORDER BY position ASC").all() as {
    id: string;
    column_id: string;
    title: string;
    description: string;
  }[];
  return columns.map((col) => ({
    id: col.id,
    title: col.title,
    cards: cards.filter((c) => c.column_id === col.id).map((c) => ({ id: c.id, columnId: c.column_id, title: c.title, description: c.description }) satisfies BoardCard),
  }));
}

export function createCard(columnId: string, title: string): BoardCard {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM board_cards WHERE column_id = ?").get(columnId) as { count: number };
  const card: BoardCard = { id: `card-${Date.now()}`, columnId, title, description: "" };
  db.prepare("INSERT INTO board_cards (id, column_id, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    card.id,
    columnId,
    title,
    "",
    count,
    Date.now(),
  );
  return card;
}

/** The kanban primitive's defining interaction — moves a real card between
 * real columns, exercised by dragging in a full product but by a plain
 * "move to" control here (agent-clickable, same reasoning as the workflow
 * canvas favoring explicit connect actions over freeform drag). */
export function moveCard(cardId: string, toColumnId: string): BoardCard | null {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM board_cards WHERE column_id = ?").get(toColumnId) as { count: number };
  const result = db.prepare("UPDATE board_cards SET column_id = ?, position = ? WHERE id = ?").run(toColumnId, count, cardId);
  if (result.changes === 0) return null;
  const row = db.prepare("SELECT id, column_id, title, description FROM board_cards WHERE id = ?").get(cardId) as {
    id: string;
    column_id: string;
    title: string;
    description: string;
  };
  return { id: row.id, columnId: row.column_id, title: row.title, description: row.description };
}

/** The modal primitive's defining interaction — edits a card's details,
 * opened/closed as a real dialog rather than inline on the board. */
export function updateCard(cardId: string, fields: { title?: string; description?: string }): BoardCard | null {
  if (fields.title !== undefined) db.prepare("UPDATE board_cards SET title = ? WHERE id = ?").run(fields.title, cardId);
  if (fields.description !== undefined) db.prepare("UPDATE board_cards SET description = ? WHERE id = ?").run(fields.description, cardId);
  const row = db.prepare("SELECT id, column_id, title, description FROM board_cards WHERE id = ?").get(cardId) as
    | { id: string; column_id: string; title: string; description: string }
    | undefined;
  if (!row) return null;
  return { id: row.id, columnId: row.column_id, title: row.title, description: row.description };
}

function seedIfEmpty(): void {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM board_columns").get() as { count: number };
  if (count > 0) return;
  seed();
}

function seed(): void {
  const insertColumn = db.prepare("INSERT INTO board_columns (id, title, position) VALUES (?, ?, ?)");
  COLUMN_ORDER.forEach((id, i) => insertColumn.run(id, { todo: "Todo", "in-progress": "In Progress", done: "Done" }[id], i));

  const insertCard = db.prepare("INSERT INTO board_cards (id, column_id, title, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  insertCard.run("card-1", "todo", "Design homepage", "", 0, 1);
  insertCard.run("card-2", "todo", "Write onboarding docs", "", 1, 2);
  insertCard.run("card-3", "in-progress", "Fix login bug", "", 0, 3);
  insertCard.run("card-4", "done", "Set up CI", "", 0, 4);
}

/** Test-utility for @cairnvibe/evals, same convention as
 * resetInvoices/resetWorkflow — deterministic seed state for a scenario's
 * before/after check. */
export function resetBoard(): void {
  db.prepare("DELETE FROM board_cards").run();
  db.prepare("DELETE FROM board_columns").run();
  seed();
}

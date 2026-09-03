// Client-safe types for the kanban board — split out from board.ts for the
// same reason workflow-types.ts is split from workflows.ts: a "use client"
// component that imports board.ts directly would transitively pull in
// db.ts's better-sqlite3 import into the browser bundle.

export interface BoardCard {
  id: string;
  columnId: string;
  title: string;
  description: string;
}

export interface BoardColumn {
  id: string;
  title: string;
  cards: BoardCard[];
}

export const COLUMN_ORDER = ["todo", "in-progress", "done"] as const;
export type ColumnId = (typeof COLUMN_ORDER)[number];

// Client-safe types for the shop — split out from shop.ts for the same
// reason board-types.ts/workflow-types.ts are split from their server
// files: a "use client" component importing the server file directly
// would bundle better-sqlite3 and fail to compile.

export interface Product {
  id: string;
  name: string;
  category: string;
  priceCents: number;
}

export interface CartLine {
  productId: string;
  name: string;
  priceCents: number;
  quantity: number;
}

export interface OrderItem {
  productId: string;
  name: string;
  quantity: number;
}

export interface Order {
  id: string;
  email: string;
  address: string;
  totalCents: number;
  items: OrderItem[];
}

export const CATEGORIES = ["Electronics", "Home", "Books"] as const;
export type Category = (typeof CATEGORIES)[number];

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

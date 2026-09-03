// A real marketplace, persisted in SQLite (lib/db.ts) — the "search-
// filter", "wizard", and "auth-gate" primitives' backing data. Same
// real-CRUD convention as invoices.ts/board.ts. Server-only (imports
// db.ts) — see shop-types.ts for what a "use client" component may
// import instead. Single-tenant "session" (a one-row logged_in flag),
// matching the rest of this demo app's convention of no real
// multi-user auth — the point is exercising a real gated flow, not a
// real identity system.
import { randomUUID } from "node:crypto";
import { db } from "./db";
import type { CartLine, Order, Product } from "./shop-types";

seedIfEmpty();

export function listProducts(filter: { q?: string; category?: string } = {}): Product[] {
  let rows = db.prepare("SELECT id, name, category, price_cents FROM shop_products ORDER BY name ASC").all() as {
    id: string;
    name: string;
    category: string;
    price_cents: number;
  }[];
  if (filter.category) rows = rows.filter((r) => r.category === filter.category);
  if (filter.q) {
    const q = filter.q.toLowerCase();
    rows = rows.filter((r) => r.name.toLowerCase().includes(q));
  }
  return rows.map((r) => ({ id: r.id, name: r.name, category: r.category, priceCents: r.price_cents }));
}

export function listCart(): CartLine[] {
  const rows = db
    .prepare(
      `SELECT p.id as product_id, p.name, p.price_cents, c.quantity
       FROM shop_cart c JOIN shop_products p ON p.id = c.product_id`,
    )
    .all() as { product_id: string; name: string; price_cents: number; quantity: number }[];
  return rows.map((r) => ({ productId: r.product_id, name: r.name, priceCents: r.price_cents, quantity: r.quantity }));
}

export function addToCart(productId: string, quantity = 1): void {
  const existing = db.prepare("SELECT quantity FROM shop_cart WHERE product_id = ?").get(productId) as { quantity: number } | undefined;
  if (existing) db.prepare("UPDATE shop_cart SET quantity = ? WHERE product_id = ?").run(existing.quantity + quantity, productId);
  else db.prepare("INSERT INTO shop_cart (product_id, quantity) VALUES (?, ?)").run(productId, quantity);
}

export function isLoggedIn(): boolean {
  const row = db.prepare("SELECT logged_in FROM shop_session WHERE id = 1").get() as { logged_in: number } | undefined;
  return row?.logged_in === 1;
}

export function login(): void {
  db.prepare("INSERT INTO shop_session (id, logged_in) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET logged_in = 1").run();
}

export function logout(): void {
  db.prepare("INSERT INTO shop_session (id, logged_in) VALUES (1, 0) ON CONFLICT(id) DO UPDATE SET logged_in = 0").run();
}

/** The auth-gate + wizard primitives' defining interaction — completes a
 * real order, but only if the real session is logged in (the policy
 * constraint an agent must respect: log in before checking out) and the
 * cart isn't empty. Returns null, not a thrown error, on either failure —
 * the route handler turns that into a real 403/400 an agent can observe
 * and recover from. */
export function placeOrder(email: string, address: string): Order | null {
  if (!isLoggedIn()) return null;
  const cart = listCart();
  if (cart.length === 0) return null;

  const totalCents = cart.reduce((sum, line) => sum + line.priceCents * line.quantity, 0);
  const items = cart.map((line) => ({ productId: line.productId, name: line.name, quantity: line.quantity }));
  const order: Order = { id: `order-${randomUUID()}`, email, address, totalCents, items };

  db.prepare("INSERT INTO shop_orders (id, email, address, total_cents, items, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    order.id,
    email,
    address,
    totalCents,
    JSON.stringify(items),
    Date.now(),
  );
  db.prepare("DELETE FROM shop_cart").run();
  return order;
}

export function listOrders(): Order[] {
  const rows = db.prepare("SELECT id, email, address, total_cents, items FROM shop_orders ORDER BY created_at ASC").all() as {
    id: string;
    email: string;
    address: string;
    total_cents: number;
    items: string;
  }[];
  return rows.map((r) => ({ id: r.id, email: r.email, address: r.address, totalCents: r.total_cents, items: JSON.parse(r.items) }));
}

function seedIfEmpty(): void {
  const { count } = db.prepare("SELECT COUNT(*) as count FROM shop_products").get() as { count: number };
  if (count > 0) return;
  seed();
}

function seed(): void {
  const insert = db.prepare("INSERT INTO shop_products (id, name, category, price_cents) VALUES (?, ?, ?, ?)");
  insert.run("prod-1", "Wireless Earbuds", "Electronics", 4999);
  insert.run("prod-2", "Desk Lamp", "Home", 2499);
  insert.run("prod-3", "Mechanical Keyboard", "Electronics", 8999);
  insert.run("prod-4", "Novel: The Long Way", "Books", 1599);
  insert.run("prod-5", "Throw Blanket", "Home", 3499);
}

/** Test-utility for @cairnvibe/evals, same convention as
 * resetInvoices/resetBoard — clears cart/orders/session and reseeds the
 * catalog, so a scenario's before/after check is deterministic. */
export function resetShop(): void {
  db.prepare("DELETE FROM shop_cart").run();
  db.prepare("DELETE FROM shop_orders").run();
  db.prepare("DELETE FROM shop_session").run();
  db.prepare("DELETE FROM shop_products").run();
  seed();
}

// The "lego piece" registry — real, reusable interaction primitives,
// composed into genre apps that match real market software. Grounded in
// BrowserGym's lesson (research item #5): one standard contract every
// environment piece implements, instead of bespoke one-off harness code
// per playground app.
//
// Adapted to Next.js's real constraints, not a literal port of the
// abstract contract: Next's App Router uses file-based routing, so a
// primitive can't register HTTP routes at runtime the way the plan's
// first sketch implied. What's actually shared and reusable is the
// SERVER-SIDE contract (reset this primitive's state, observe its real
// current state, know what capability it exercises) — every genre app's
// own API route files stay real Next.js files (already true for
// examples/demo-app/lib/workflows.ts and lib/invoices.ts), thin wrappers
// around that contract. The React UI itself is reused the way real
// software reuses interaction patterns — by following the same
// convention when building a new genre page — not through a forced
// shared-component import across unrelated demo apps.

import type { CapabilityTag } from "../taxonomy";

export interface PlaygroundPrimitive {
  id: string;
  /** What this primitive is, for the dashboard and for anyone adding a new genre. */
  description: string;
  capabilities: CapabilityTag[];
  /** Path, relative to a scenario's baseUrl, that resets this primitive's real state. */
  resetPath: string;
  /** Path that returns this primitive's real current state as JSON — what verify checks read. */
  observePath: string;
}

export const PRIMITIVES = {
  canvas: {
    id: "canvas",
    description: "A free-form node canvas — add, configure, and connect nodes (examples/demo-app's workflow builder).",
    capabilities: ["multi-step-composite"],
    resetPath: "/api/workflows/reset",
    observePath: "/api/workflows",
  },
  "state-machine": {
    id: "state-machine",
    description: "An entity with a real lifecycle (a workflow node's config + connection state must all be valid together for a run to succeed).",
    capabilities: ["content-ops"],
    resetPath: "/api/workflows/reset",
    observePath: "/api/workflows",
  },
  "table-crud": {
    id: "table-crud",
    description: "A real data table with create/archive operations (examples/demo-app's invoices page).",
    capabilities: ["content-ops"],
    resetPath: "/api/invoices/reset",
    observePath: "/api/invoices",
  },
  kanban: {
    id: "kanban",
    description: "Real columns and cards with a real move-between-columns state transition (examples/demo-app's board).",
    capabilities: ["content-ops", "multi-step-composite"],
    resetPath: "/api/board/reset",
    observePath: "/api/board",
  },
  modal: {
    id: "modal",
    description: "A dynamically-opened dialog for editing an entity's details, distinct from inline page edits (examples/demo-app's board card editor).",
    capabilities: ["content-ops"],
    resetPath: "/api/board/reset",
    observePath: "/api/board",
  },
  "search-filter": {
    id: "search-filter",
    description: "A real query (text + category) against a real catalog, driven through the URL's own search params (examples/demo-app's shop).",
    capabilities: ["info-seeking"],
    resetPath: "/api/shop/reset",
    observePath: "/api/shop/products",
  },
  wizard: {
    id: "wizard",
    description: "A real multi-step flow (review, shipping, confirm) ending in a real state-creating submit (examples/demo-app's checkout).",
    capabilities: ["multi-step-composite", "content-ops"],
    resetPath: "/api/shop/reset",
    observePath: "/api/shop/orders",
  },
  "auth-gate": {
    id: "auth-gate",
    description: "A real business rule enforced server-side, not just hidden in the UI: checkout returns a real 403 when the session isn't logged in (examples/demo-app's shop checkout).",
    capabilities: ["policy-constraint"],
    resetPath: "/api/shop/reset",
    observePath: "/api/shop/auth",
  },
} as const satisfies Record<string, PlaygroundPrimitive>;

export type PrimitiveId = keyof typeof PRIMITIVES;

export interface PlaygroundGenre {
  id: string;
  /** Which real market software this genre is shaped after. */
  modeledAfter: string;
  primitives: PrimitiveId[];
  /** Path to load in the browser before driving a scenario against this genre. */
  path: string;
}

export const GENRES = {
  "workflow-builder": {
    id: "workflow-builder",
    modeledAfter: "n8n (node-based automation)",
    primitives: ["canvas", "state-machine"],
    path: "/workflows",
  },
  "crud-dashboard": {
    id: "crud-dashboard",
    modeledAfter: "a generic admin/CRM data table",
    primitives: ["table-crud"],
    path: "/invoices",
  },
  "kanban-tracker": {
    id: "kanban-tracker",
    modeledAfter: "Trello/Linear (kanban board)",
    primitives: ["kanban", "modal"],
    path: "/board",
  },
  // The plan's original sketch composed this genre as search-filter +
  // table-crud + wizard + auth-gate. Deliberately dropped table-crud
  // here: this registry binds each primitive id to ONE concrete
  // resetPath/observePath (table-crud already means "/api/invoices"),
  // so reusing that literal id for the shop's own catalog would silently
  // reset/observe the WRONG app's data when a marketplace scenario runs.
  // A genuinely reusable per-genre parameterization is a real
  // architectural gap (see DEVELOPMENT.md's step 6b entry) — worth
  // fixing if a third genre ever wants its own "table-crud"-shaped data,
  // but not invented here just to satisfy the plan's literal wording.
  marketplace: {
    id: "marketplace",
    modeledAfter: "Amazon (search, cart, checkout)",
    primitives: ["search-filter", "wizard", "auth-gate"],
    path: "/shop",
  },
} as const satisfies Record<string, PlaygroundGenre>;

export type GenreId = keyof typeof GENRES;

/** Every capability tag exercised by a genre, deduped across its primitives — what a scenario against this genre can honestly claim to cover. */
export function capabilitiesOf(genreId: GenreId): CapabilityTag[] {
  const genre = GENRES[genreId];
  const tags = new Set<CapabilityTag>();
  for (const primitiveId of genre.primitives) {
    for (const tag of PRIMITIVES[primitiveId].capabilities) tags.add(tag);
  }
  return [...tags];
}

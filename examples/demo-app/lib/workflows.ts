// Server-only: the real store + logic behind the workflow builder
// playground (app/workflows/page.tsx) — the "n8n-shaped" genre for
// @cairnvibe/evals (packages/evals). Deliberately real, not a mock:
// nodes/edges persist in SQLite (lib/db.ts) the same way invoices do, and
// "run test" actually validates the real graph, not a canned response.
//
// Scoped deliberately for this pass: node position is a fixed vertical
// order (append order), not free-form drag/drop. Cairn's agent loop has no
// "drag" verb yet (only click/fill/read/call_tool/batch) — testing
// drag-and-drop now would only re-confirm a gap already documented in the
// eval plan, not teach anything new. Connecting nodes is still a real,
// non-trivial multi-step interaction (a <select> per node, not a single
// click) — that's the part actually worth stressing right now.
//
// Client-safe types/constants live in workflow-types.ts, not here — see
// that file's doc comment for why the split exists.
import { db } from "./db";
import { NODE_TYPES, type NodeType, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "./workflow-types";

export { NODE_TYPES, type NodeType, type WorkflowEdge, type WorkflowGraph, type WorkflowNode } from "./workflow-types";

function nodeRow(row: { id: string; type: string; label: string; config: string }): WorkflowNode {
  return { id: row.id, type: row.type as NodeType, label: row.label, config: JSON.parse(row.config) };
}

export function getWorkflow(): WorkflowGraph {
  const nodes = (db.prepare("SELECT id, type, label, config FROM workflow_nodes ORDER BY created_at ASC").all() as any[]).map(nodeRow);
  const edges = db.prepare("SELECT from_id as 'from', to_id as 'to' FROM workflow_edges").all() as WorkflowEdge[];
  return { nodes, edges };
}

export function addNode(type: NodeType): WorkflowNode {
  const spec = NODE_TYPES.find((n) => n.type === type);
  if (!spec) throw new Error(`unknown node type: ${type}`);
  const node: WorkflowNode = { id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, type, label: spec.label, config: {} };
  db.prepare("INSERT INTO workflow_nodes (id, type, label, config, created_at) VALUES (?, ?, ?, ?, ?)").run(
    node.id,
    node.type,
    node.label,
    JSON.stringify(node.config),
    Date.now(),
  );
  return node;
}

export function configureNode(id: string, config: Record<string, string>): WorkflowNode | null {
  const existing = db.prepare("SELECT id, type, label, config FROM workflow_nodes WHERE id = ?").get(id) as any;
  if (!existing) return null;
  const merged = { ...JSON.parse(existing.config), ...config };
  db.prepare("UPDATE workflow_nodes SET config = ? WHERE id = ?").run(JSON.stringify(merged), id);
  return nodeRow({ ...existing, config: JSON.stringify(merged) });
}

export function connectNodes(from: string, to: string): WorkflowEdge | null {
  const nodes = db.prepare("SELECT id FROM workflow_nodes WHERE id IN (?, ?)").all(from, to) as { id: string }[];
  if (nodes.length !== 2) return null;
  db.prepare("INSERT OR IGNORE INTO workflow_edges (from_id, to_id) VALUES (?, ?)").run(from, to);
  return { from, to };
}

export function resetWorkflow(): void {
  db.prepare("DELETE FROM workflow_nodes").run();
  db.prepare("DELETE FROM workflow_edges").run();
}

export interface RunTestResult {
  ok: boolean;
  message: string;
}

/** A genuinely real check, not a canned response: is there at least one
 * trigger connected (directly, or through a configured filter) to a fully
 * configured action? Runs the same graph a real workflow engine would. */
export function runTest(): RunTestResult {
  const { nodes, edges } = getWorkflow();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const specByType = new Map(NODE_TYPES.map((s) => [s.type, s]));

  const triggers = nodes.filter((n) => specByType.get(n.type)?.kind === "trigger");
  if (triggers.length === 0) return { ok: false, message: "No trigger node yet — add one to start the workflow." };

  for (const trigger of triggers) {
    const reachable = reachableActions(trigger.id, edges, byId, specByType);
    for (const action of reachable) {
      const spec = specByType.get(action.type)!;
      const missing = spec.fields.filter((f) => !action.config[f]?.trim());
      if (missing.length > 0) continue;
      const target = action.config[spec.fields[0]];
      return { ok: true, message: `Test run: "${trigger.label}" would trigger "${action.label}" -> ${target}.` };
    }
  }
  return { ok: false, message: "Trigger isn't connected to a fully configured action yet." };
}

function reachableActions(
  fromId: string,
  edges: WorkflowEdge[],
  byId: Map<string, WorkflowNode>,
  specByType: Map<NodeType, (typeof NODE_TYPES)[number]>,
  seen = new Set<string>(),
): WorkflowNode[] {
  if (seen.has(fromId)) return [];
  seen.add(fromId);
  const results: WorkflowNode[] = [];
  for (const edge of edges.filter((e) => e.from === fromId)) {
    const next = byId.get(edge.to);
    if (!next) continue;
    const kind = specByType.get(next.type)?.kind;
    if (kind === "action") results.push(next);
    else results.push(...reachableActions(next.id, edges, byId, specByType, seen));
  }
  return results;
}

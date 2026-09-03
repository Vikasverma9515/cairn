// Client-safe types/constants for the workflow builder — split out from
// workflows.ts specifically so app/workflows/page.tsx ("use client") never
// transitively pulls in workflows.ts's `import { db } from "./db"`
// (better-sqlite3, a server-only native module) into the browser bundle.
// Found live: importing anything at all from workflows.ts into a client
// component bundles the whole module, db.ts's top-level side effect
// included, which fails to compile ("Module not found: Can't resolve 'fs'").

export type NodeType = "trigger-form-submitted" | "action-send-email" | "action-send-slack" | "filter-field-equals";

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  config: Record<string, string>;
}

export interface WorkflowEdge {
  from: string;
  to: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export const NODE_TYPES: { type: NodeType; label: string; kind: "trigger" | "action" | "filter"; fields: string[] }[] = [
  { type: "trigger-form-submitted", label: "Form Submitted", kind: "trigger", fields: ["formName"] },
  { type: "action-send-email", label: "Send Email", kind: "action", fields: ["to"] },
  { type: "action-send-slack", label: "Send Slack Message", kind: "action", fields: ["channel"] },
  { type: "filter-field-equals", label: "Only If Field Equals", kind: "filter", fields: ["field", "value"] },
];

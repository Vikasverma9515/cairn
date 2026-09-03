"use client";

import { useEffect, useState } from "react";
import type { NodeType, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../../lib/workflow-types";
import { NODE_TYPES } from "../../lib/workflow-types";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  return res.json();
}

export default function WorkflowsPage() {
  const [graph, setGraph] = useState<WorkflowGraph>({ nodes: [], edges: [] });
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function refresh() {
    setGraph(await getJson<WorkflowGraph>("/api/workflows"));
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function addNode(type: NodeType) {
    await fetch("/api/workflows/nodes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type }) });
    await refresh();
  }

  async function saveConfig(node: WorkflowNode, field: string, value: string) {
    await fetch(`/api/workflows/nodes/${node.id}/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { ...node.config, [field]: value } }),
    });
    await refresh();
  }

  async function connect(from: string, to: string) {
    if (!to) return;
    await fetch("/api/workflows/edges", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to }) });
    await refresh();
  }

  async function runTest() {
    const result = await (await fetch("/api/workflows/run-test", { method: "POST" })).json();
    setTestResult(result);
  }

  return (
    <main className="mx-auto max-w-4xl px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Workflows</h1>
      <p className="mt-3 text-gray-600">
        Build an automation: add a trigger and one or more actions, wire them together, then run a test.
      </p>

      <div className="mt-8 flex gap-3 flex-wrap">
        {NODE_TYPES.map((spec) => (
          <button
            key={spec.type}
            data-ai={`add-${spec.type}`}
            onClick={() => void addNode(spec.type)}
            className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
          >
            + {spec.label}
          </button>
        ))}
      </div>

      <div className="mt-8 flex flex-col gap-4">
        {graph.nodes.length === 0 && <p className="text-sm text-gray-400">No nodes yet — add a trigger to start.</p>}
        {graph.nodes.map((node) => (
          <NodeCard key={node.id} node={node} allNodes={graph.nodes} edges={graph.edges} onSaveConfig={saveConfig} onConnect={connect} />
        ))}
      </div>

      {graph.edges.length > 0 && (
        <div className="mt-6 text-sm text-gray-500">
          {graph.edges.map((e) => (
            <div key={`${e.from}-${e.to}`}>
              {labelFor(graph.nodes, e.from)} &rarr; {labelFor(graph.nodes, e.to)}
            </div>
          ))}
        </div>
      )}

      <div className="mt-10 border-t border-gray-200 pt-6">
        <button
          data-ai="run-test"
          onClick={() => void runTest()}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Run test
        </button>
        {testResult && (
          <p className={`mt-3 text-sm ${testResult.ok ? "text-green-700" : "text-amber-700"}`}>{testResult.message}</p>
        )}
      </div>
    </main>
  );
}

function labelFor(nodes: WorkflowNode[], id: string): string {
  return nodes.find((n) => n.id === id)?.label ?? id;
}

function NodeCard({
  node,
  allNodes,
  edges,
  onSaveConfig,
  onConnect,
}: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
  edges: WorkflowEdge[];
  onSaveConfig: (node: WorkflowNode, field: string, value: string) => void;
  onConnect: (from: string, to: string) => void;
}) {
  const spec = NODE_TYPES.find((s) => s.type === node.type)!;
  const connectedTo = edges.find((e) => e.from === node.id)?.to ?? "";
  const otherNodes = allNodes.filter((n) => n.id !== node.id);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-xs uppercase tracking-wide text-gray-400">{spec.kind}</span>
          <div className="font-medium text-gray-800">{node.label}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {spec.fields.map((field) => (
          <label key={field} className="text-sm text-gray-600">
            {fieldLabel(field)}
            <input
              aria-label={`${node.label} ${fieldLabel(field)}`}
              defaultValue={node.config[field] ?? ""}
              // onChange, not onBlur: Cairn's own fill execution
              // (element-ladder.ts's fillElement) sets the value via the
              // native setter and dispatches input+change — never a blur —
              // so a save gated on blur would silently never fire for a
              // real agent-driven fill. Found live testing this exact page.
              onChange={(e) => onSaveConfig(node, field, e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder={fieldLabel(field)}
            />
          </label>
        ))}

        {otherNodes.length > 0 && (
          <label className="text-sm text-gray-600">
            Connects to
            <select
              aria-label={`${node.label} connects to`}
              value={connectedTo}
              onChange={(e) => onConnect(node.id, e.target.value)}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">None</option>
              {otherNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = { formName: "Form name", to: "Send to (email)", channel: "Slack channel", field: "Field", value: "Value" };
  return labels[field] ?? field;
}

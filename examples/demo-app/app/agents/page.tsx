"use client";

import { useState } from "react";

const AGENTS = [
  { name: "Aria", desc: "Order-taking assistant for a small bakery." },
  { name: "KAI", desc: "Friendly receptionist and appointment scheduler." },
];

export default function AgentsPage() {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  return (
    <main className="mx-auto max-w-2xl px-8 py-16">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Agent Builder</h1>
        {/* No data-ai and no network call on click — this button only
            reveals the form below. The regression test for click-only
            `do`: real UI actions that aren't a fetch/axios call at all. */}
        <button
          onClick={() => setCreating(true)}
          className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          New Agent
        </button>
      </div>
      <p className="mt-3 text-gray-600">Create custom voice agents with their own instructions and persona.</p>
      <div className="mt-8 flex flex-col gap-3">
        {AGENTS.map((a) => (
          <div key={a.name} className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm">
            <div className="font-medium text-gray-800">{a.name}</div>
            <div className="text-sm text-gray-500">{a.desc}</div>
          </div>
        ))}
      </div>
      {creating && (
        <div className="mt-6 rounded-xl border border-indigo-200 bg-indigo-50 p-5">
          <h2 className="font-medium text-gray-800">New agent</h2>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent name"
            className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      )}
    </main>
  );
}

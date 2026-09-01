"use client";

import { useState } from "react";

// Deliberately no data-ai on any row — this is the regression test for the
// runtime element scanner: a dynamically-rendered list a developer never
// manually tagged (the same shape VOXERA's real Sessions page has) should
// still be addressable through a live DOM scan, not only the static manifest.
const SESSIONS = [
  { id: "tel-jBU07k_CX74V", events: 33, emotion: "Fear" },
  { id: "tel-FxC8h8wRSR11", events: 22, emotion: "Sadness" },
  { id: "browser-Q5TttWbM7UBW", events: 80, emotion: "Neutral" },
  { id: "tel-0tV-PXX3MTb2", events: 101, emotion: "Neutral" },
  { id: "browser-iRx7HQLnRP4P", events: 22, emotion: "Sadness" },
];

export default function SessionsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = SESSIONS.find((s) => s.id === selectedId);

  return (
    <main className="mx-auto flex max-w-4xl gap-6 px-8 py-16">
      <div className="flex-1">
        <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Sessions</h1>
        <p className="mt-3 text-gray-600">
          Recent conversation sessions, rendered from data with no per-row id — clicking one selects it below.
        </p>
        <div className="mt-6 flex flex-col gap-3">
          {SESSIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`flex items-center justify-between rounded-xl border px-5 py-4 text-left shadow-sm transition ${
                selectedId === s.id ? "border-indigo-400 bg-indigo-50" : "border-gray-200 bg-white hover:border-gray-300"
              }`}
            >
              <span className="font-mono text-sm text-gray-800">{s.id}</span>
              <span className="flex items-center gap-3 text-xs text-gray-500">
                <span>{s.events} events</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 font-medium text-gray-600">{s.emotion}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
      <div className="w-72 shrink-0 rounded-xl border border-dashed border-gray-300 bg-white p-5">
        {selected ? (
          <>
            <h2 className="font-mono text-sm text-gray-800">{selected.id}</h2>
            <p className="mt-2 text-sm text-gray-600">
              {selected.events} events recorded, dominant emotion {selected.emotion}.
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-400">Select a session to view its detail.</p>
        )}
      </div>
    </main>
  );
}

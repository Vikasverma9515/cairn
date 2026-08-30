import { TriangleAlert } from "lucide-react";
import { summarizeMisses } from "@cairn/sdk/dashboard";
import { missesStore } from "../../lib/misses-store";

// Reads mutable in-memory state per request — never statically prerender this.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const summary = summarizeMisses(missesStore.list());

  return (
    <main className="mx-auto max-w-2xl px-8 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-gray-900">Failure Dashboard</h1>
      <p className="mt-3 text-gray-600">Element-lookup misses the Copilot widget has hit, aggregated server-side.</p>
      {summary.length === 0 ? (
        <div className="mt-8 flex items-center gap-3 rounded-xl border border-dashed border-gray-300 bg-white px-5 py-8 text-gray-500">
          <TriangleAlert size={18} className="text-gray-400" />
          No misses recorded yet.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-gray-200 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
              <tr>
                <th className="px-4 py-3 font-medium">Route</th>
                <th className="px-4 py-3 font-medium">Attempted target</th>
                <th className="px-4 py-3 font-medium">Count</th>
                <th className="px-4 py-3 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {summary.map((s) => (
                <tr key={`${s.route}::${s.attempted}`} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">{s.route}</td>
                  <td className="px-4 py-3 font-medium text-gray-800">{s.attempted}</td>
                  <td className="px-4 py-3 text-gray-600">{s.count}</td>
                  <td className="px-4 py-3 text-gray-500">{s.lastSeen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}

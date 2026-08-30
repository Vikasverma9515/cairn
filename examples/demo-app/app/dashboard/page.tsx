import { summarizeMisses } from "@cairn/sdk/dashboard";
import { missesStore } from "../../lib/misses-store";

// Reads mutable in-memory state per request — never statically prerender this.
export const dynamic = "force-dynamic";

export default function DashboardPage() {
  const summary = summarizeMisses(missesStore.list());

  return (
    <main style={{ padding: 40, maxWidth: 640 }}>
      <h1>Failure Dashboard</h1>
      <p>Element-lookup misses the Copilot widget has hit, aggregated server-side.</p>
      {summary.length === 0 ? (
        <p>No misses recorded yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Route</th>
              <th>Attempted target</th>
              <th>Count</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((s) => (
              <tr key={`${s.route}::${s.attempted}`}>
                <td>{s.route}</td>
                <td>{s.attempted}</td>
                <td>{s.count}</td>
                <td>{s.lastSeen}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

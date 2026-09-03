import { getCommits, getComparisonRows, type ComparisonRow } from "../../lib/data";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<ComparisonRow["status"], string> = {
  regressed: "regressed",
  improved: "improved",
  unchanged: "unchanged",
  "new-in-b": "new in B",
  "missing-in-b": "missing in B",
};

const STATUS_CLASS: Record<ComparisonRow["status"], string> = {
  regressed: "pill-fail",
  improved: "pill-pass",
  unchanged: "pill-neutral",
  "new-in-b": "pill-neutral",
  "missing-in-b": "pill-neutral",
};

function fmt(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toFixed(2);
}

function delta(a: number | null | undefined, b: number | null | undefined): string {
  if (a === null || a === undefined || b === null || b === undefined) return "";
  const d = b - a;
  if (Math.abs(d) < 0.01) return "";
  return d > 0 ? ` (+${d.toFixed(2)})` : ` (${d.toFixed(2)})`;
}

export default function ComparePage({ searchParams }: { searchParams: { a?: string; b?: string } }) {
  const commits = getCommits();

  if (commits.length === 0) {
    return (
      <>
        <h1>Compare</h1>
        <p className="subtitle">Pick two commits and see score/latency diffs per scenario, side by side.</p>
        <div className="empty-state">
          No runs recorded yet. Run <code>npm run evals</code> in <code>packages/evals</code> to populate this dashboard.
        </div>
      </>
    );
  }

  const commitA = searchParams.a && commits.some((c) => c.commit === searchParams.a) ? searchParams.a : commits[Math.min(1, commits.length - 1)].commit;
  const commitB = searchParams.b && commits.some((c) => c.commit === searchParams.b) ? searchParams.b : commits[0].commit;
  const rows = getComparisonRows(commitA, commitB);

  return (
    <>
      <h1>Compare</h1>
      <p className="subtitle">Score/latency diffs per scenario between two commits — regressions flagged in red.</p>

      <form method="GET" className="compare-form">
        <label>
          A (baseline)
          <select name="a" defaultValue={commitA}>
            {commits.map((c) => (
              <option key={c.commit} value={c.commit}>
                {c.commit}
              </option>
            ))}
          </select>
        </label>
        <label>
          B (candidate)
          <select name="b" defaultValue={commitB}>
            {commits.map((c) => (
              <option key={c.commit} value={c.commit}>
                {c.commit}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="run-button">
          Compare
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="empty-state">No scenario shares a run at either commit.</div>
      ) : (
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>pass^k A</th>
                <th>pass^k B</th>
                <th>taskSuccess</th>
                <th>efficiency</th>
                <th>correctness</th>
                <th>safety</th>
                <th>latency</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.scenarioId}::${row.transport}`}>
                  <td>
                    <div className="card-title" style={{ fontSize: 13 }}>
                      {row.scenarioName}
                    </div>
                    <div className="card-meta">
                      {row.scenarioId} · {row.transport}
                    </div>
                  </td>
                  <td>{row.a ? (row.a.passAtK ? "pass" : "fail") : "–"}</td>
                  <td>{row.b ? (row.b.passAtK ? "pass" : "fail") : "–"}</td>
                  <td>
                    {fmt(row.b?.avgTaskSuccess ?? row.a?.avgTaskSuccess)}
                    <span className="delta">{delta(row.a?.avgTaskSuccess, row.b?.avgTaskSuccess)}</span>
                  </td>
                  <td>
                    {fmt(row.b?.avgEfficiency ?? row.a?.avgEfficiency)}
                    <span className="delta">{delta(row.a?.avgEfficiency, row.b?.avgEfficiency)}</span>
                  </td>
                  <td>
                    {fmt(row.b?.avgCorrectness ?? row.a?.avgCorrectness)}
                    <span className="delta">{delta(row.a?.avgCorrectness, row.b?.avgCorrectness)}</span>
                  </td>
                  <td>
                    {fmt(row.b?.avgSafety ?? row.a?.avgSafety)}
                    <span className="delta">{delta(row.a?.avgSafety, row.b?.avgSafety)}</span>
                  </td>
                  <td>
                    {fmt(row.b?.avgLatency ?? row.a?.avgLatency)}
                    <span className="delta">{delta(row.a?.avgLatency, row.b?.avgLatency)}</span>
                  </td>
                  <td>
                    <span className={`pill ${STATUS_CLASS[row.status]}`}>{STATUS_LABEL[row.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

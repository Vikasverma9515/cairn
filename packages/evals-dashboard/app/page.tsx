import { getScenarioSummaries } from "../lib/data";

export const dynamic = "force-dynamic";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function ScenarioListPage() {
  const summaries = getScenarioSummaries();

  if (summaries.length === 0) {
    return (
      <>
        <h1>Scenarios</h1>
        <p className="subtitle">Pass/fail history across every scenario × transport pair, from the real run history.</p>
        <div className="empty-state">
          No runs recorded yet. Run <code>npm run evals</code> in <code>packages/evals</code> against a live playground app to populate this dashboard.
        </div>
      </>
    );
  }

  return (
    <>
      <h1>Scenarios</h1>
      <p className="subtitle">
        {summaries.length} scenario × transport {summaries.length === 1 ? "pair" : "pairs"} — latest pass^k result, capability tags, and run history.
      </p>
      <div className="card-list">
        {summaries.map((s) => (
          <a key={`${s.scenarioId}::${s.transport}`} className="card" href={`/runs/${s.latestTrialGroup}`}>
            <div className="card-top">
              <div>
                <div className="card-title">{s.scenarioName}</div>
                <div className="card-meta">
                  {s.scenarioId} · {s.latestCommit} · {relativeTime(s.latestRanAt)}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="transport-badge">{s.transport}</span>
                <span className={`pill ${s.passAtK ? "pill-pass" : "pill-fail"}`}>
                  {s.passAtK ? "pass" : "fail"}^{s.latestRuns.length}
                </span>
              </div>
            </div>
            <div className="tag-row">
              {s.capabilities.map((tag) => (
                <span key={tag} className="tag">
                  {tag}
                </span>
              ))}
            </div>
            {s.history.length > 1 && (
              <div className="sparkline" title={`${s.history.length} trial groups recorded`}>
                {s.history.map((h) => (
                  <span key={h.trialGroup} className={`spark-dot ${h.passAtK ? "pass" : "fail"}`} title={`${h.commit} — ${h.passAtK ? "pass" : "fail"}`} />
                ))}
              </div>
            )}
          </a>
        ))}
      </div>
    </>
  );
}

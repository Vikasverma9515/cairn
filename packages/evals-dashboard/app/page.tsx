import { getRunSummaries, getGoldenDataset, getScenarioSummaries } from "../lib/data";
import { TrendChart } from "../components/TrendChart";

export const dynamic = "force-dynamic";

const DIMENSIONS = [
  { key: "taskSuccess", label: "Task success", desc: "Did the real final state actually satisfy the goal — never the agent's own claim." },
  { key: "efficiency", label: "Efficiency", desc: "Real steps taken vs. a reasonable, non-wasteful approach." },
  { key: "correctness", label: "Correctness", desc: "Every target/tool used was real — nothing invented or hallucinated." },
  { key: "safety", label: "Safety", desc: "Nothing destructive or out-of-scope beyond what the goal asked for." },
  { key: "latency", label: "Latency", desc: "Voice only — real per-stage timing against the turn-taking budget." },
  { key: "persona", label: "Persona", desc: "Voice only — does the spoken ack sound like a person, not a script." },
  { key: "policyCompliance", label: "Policy compliance", desc: "Scenarios with a stated business rule — was it actually respected." },
] as const;

// Explicit "en-US" locale, not `undefined` — a real hydration mismatch
// found live: Node's default locale (server render) and the browser's own
// (client render) can format the SAME date differently ("Sep 4" vs
// "4 Sept"), and React flags any text mismatch as a hydration error.
function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export default function OverviewPage() {
  const runs = getRunSummaries();
  const dataset = getGoldenDataset();
  const scenarioSummaries = getScenarioSummaries();

  if (runs.length === 0) {
    return (
      <>
        <h1>Cairn Evals</h1>
        <p className="subtitle">Real, LLM-judged runs against a live playground app — no runs recorded yet.</p>
        <div className="empty-state">
          Run <code>npm run evals</code> in <code>packages/evals</code> against a live playground app to populate this dashboard.
        </div>
      </>
    );
  }

  const latest = runs[runs.length - 1];
  const previous = runs.length > 1 ? runs[runs.length - 2] : null;
  const scoreDelta = previous ? latest.overallScore - previous.overallScore : null;
  const totalScenarios = dataset.length;
  const capabilitiesCovered = new Set(dataset.flatMap((s) => s.capabilities)).size;

  return (
    <>
      <h1>Cairn Evals</h1>
      <p className="subtitle">
        How well Cairn's agent actually completes real goals in a real app — LLM-judged against real final state, run over run.
      </p>

      <div className="hero">
        <div className="hero-score">
          <div className="hero-score-num">{latest.overallScore}</div>
          <div className="hero-score-label">
            Overall score
            {scoreDelta !== null && (
              <span className={`hero-delta ${scoreDelta > 0 ? "up" : scoreDelta < 0 ? "down" : ""}`}>
                {scoreDelta > 0 ? "▲" : scoreDelta < 0 ? "▼" : "="} {scoreDelta > 0 ? "+" : ""}
                {scoreDelta}
              </span>
            )}
          </div>
        </div>
        <div className="hero-stats">
          <div>
            <div className="hero-stat-num">{Math.round(latest.passRate * 100)}%</div>
            <div className="hero-stat-label">pass^k rate, latest run</div>
          </div>
          <div>
            <div className="hero-stat-num">{totalScenarios}</div>
            <div className="hero-stat-label">golden scenarios</div>
          </div>
          <div>
            <div className="hero-stat-num">{capabilitiesCovered}</div>
            <div className="hero-stat-label">capability dimensions</div>
          </div>
          <div>
            <div className="hero-stat-num">{runs.length}</div>
            <div className="hero-stat-label">{runs.length === 1 ? "run recorded" : "runs recorded"}</div>
          </div>
          <div>
            <div className="hero-stat-num" style={{ fontFamily: "var(--mono)", fontSize: 15 }}>
              {latest.commit}
            </div>
            <div className="hero-stat-label">latest commit · {fmtDate(latest.ranAt)}</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>Score over time</h2>
          <a className="section-link" href="/compare">
            compare two runs →
          </a>
        </div>
        <div className="chart-card">
          <TrendChart points={runs.map((r) => ({ commit: r.commit, ranAt: r.ranAt, overallScore: r.overallScore, passRate: r.passRate }))} />
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>Latest run, by dimension</h2>
          <a className="section-link" href="/capabilities">
            by capability →
          </a>
        </div>
        <div className="dimension-grid">
          {DIMENSIONS.map((d) => {
            const value = latest.dimensionAverages[d.key];
            return (
              <div key={d.key} className="dimension-card">
                <div className="dimension-name">{d.label}</div>
                <div className="dimension-desc">{d.desc}</div>
                {value === null ? <div className="dimension-value muted">n/a this run</div> : <div className="dimension-value">{Math.round(value * 100)}%</div>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="section">
        <h2>How this is measured</h2>
        <div className="methodology-grid">
          <div className="methodology-card">
            <p>
              Every run drives a real Playwright browser (typed) or a real synthesized-audio call (voice) against a live playground app —
              Cairn's own widget code runs completely unmodified, exactly as a real user would trigger it.
            </p>
            <p>
              A separate model — never the agent itself — grades each trace against the app's real final state, fetched independently
              after the run, never against what the agent claims happened. This structural separation is deliberate: an agent grading its
              own success is a known, measured failure mode (self-graded claims are frequently wrong even when confident).
            </p>
            <p>
              Each scenario runs <strong>k times</strong> and only counts as passing if <strong>every</strong> trial passes (pass^k,
              τ-bench's reliability check) — a scenario that works 2 times out of 3 is not reliable, and a single lucky run never hides that.
            </p>
          </div>
          <div className="methodology-card">
            <ul className="methodology-list">
              <li>
                <strong>Task taxonomy</strong> — capability tags grounded in WebArena's info-seeking / navigation / content-ops /
                unachievable categories, extended with τ-bench's policy-constraint and clarification-seeking dimensions.{" "}
                <span className="cite">(WebArena; τ-bench)</span>
              </li>
              <li>
                <strong>7 graded dimensions</strong> per run — task success, efficiency, correctness, safety, plus voice-only latency and
                persona, plus policy compliance where a scenario declares a real business rule.
              </li>
              <li>
                <strong>Real induced failures</strong> — some scenarios deliberately break something (a missing element, a rate limit) to
                check the agent degrades honestly instead of hallucinating success.
              </li>
              <li>
                <strong>Real barge-in probes</strong> — separate, mechanically-checked assertions on live WebSocket timing: does a real
                interruption actually stop the agent, does background noise correctly not.
              </li>
            </ul>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <h2>The golden dataset</h2>
          <span className="section-link">{dataset.length} scenarios, real fixtures — not code</span>
        </div>
        <div className="dataset-table-wrap">
          <table className="dataset-table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th>Goal</th>
                <th>Capabilities</th>
                <th>Transports</th>
              </tr>
            </thead>
            <tbody>
              {dataset.map((s) => {
                const runsForScenario = scenarioSummaries.filter((sc) => sc.scenarioId === s.id);
                return (
                  <tr key={s.id}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{s.name}</div>
                      <div className="dataset-id">{s.id}</div>
                    </td>
                    <td className="dataset-goal">&ldquo;{s.goal}&rdquo;</td>
                    <td>
                      <div className="tag-row" style={{ marginTop: 0 }}>
                        {s.capabilities.map((c) => (
                          <span key={c} className="tag">
                            {c}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {s.transports.join(" + ")}
                      {runsForScenario.length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          {runsForScenario.map((r) => (
                            <span key={r.transport} className={`pill ${r.passAtK ? "pill-pass" : "pill-fail"}`} style={{ marginRight: 4 }}>
                              {r.transport}: {r.passAtK ? "pass" : "fail"}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

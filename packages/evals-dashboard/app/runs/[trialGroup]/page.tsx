import { notFound } from "next/navigation";
import { getTrialGroup } from "../../../lib/data";
import { summarizeRoundTrip } from "../../../lib/trace-summary";
import type { StoredRun } from "@cairnvibe/evals/store";
import type { CopilotRoundTrip } from "@cairnvibe/evals/trace";

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** One real step, readable first — a real narrative line ("clicked X",
 * "typed Y into Z"), timing, and the raw request/response one click away
 * for anyone who wants it — not the default view. Same "input/output
 * line per real step" shape Braintrust's own trace viewer uses. */
function RoundTripStep({ trip, index }: { trip: CopilotRoundTrip; index: number }) {
  const ms = trip.respondedAt - trip.requestedAt;
  const summary = summarizeRoundTrip(trip.requestBody, trip.responseBody);
  return (
    <div className="trace-step" data-kind={summary.kind}>
      <div className="trace-step-num">{index + 1}</div>
      <div className="trace-step-body">
        <div className="trace-step-headline">
          {summary.question && index === 0 && <span className="trace-step-question">&ldquo;{summary.question}&rdquo;</span>}
          <span className={`trace-step-verb kind-${summary.kind} ${summary.verb ? `verb-${summary.verb}` : ""}`}>
            {summary.kind === "verb" ? summary.verb : summary.kind === "unparseable" ? "error" : summary.kind}
          </span>
          <span className="trace-step-text">{summary.headline}</span>
        </div>
        <div className="trace-step-meta">
          {ms}ms
          <details className="trace-step-raw">
            <summary>view raw</summary>
            <div className="section-label" style={{ padding: "8px 0 4px" }}>
              request
            </div>
            <pre className="json-block">{json(trip.requestBody)}</pre>
            <div className="section-label" style={{ padding: "8px 0 4px" }}>
              response
            </div>
            <pre className="json-block">{json(trip.responseBody)}</pre>
          </details>
        </div>
      </div>
    </div>
  );
}

function TrialCard({ run, total }: { run: StoredRun; total: number }) {
  const v = run.verdict;
  const dims: Array<[string, number | null]> = [
    ["task success", v.taskSuccess],
    ["efficiency", v.efficiency],
    ["correctness", v.correctness],
    ["safety", v.safety],
    ["latency", v.latency],
    ["persona", v.persona],
    ["policy", v.policyCompliance],
  ];

  return (
    <details className="trace" open={total <= 3}>
      <summary>
        <span>
          trial {run.trialIndex}/{total} — {run.result.transport}
        </span>
        <span className={`pill ${v.pass ? "pill-pass" : "pill-fail"}`}>{v.pass ? "pass" : "fail"}</span>
      </summary>
      <div className="trace-body">
        <div className="verdict-dim-row">
          {dims.map(([label, val]) =>
            val === null ? null : (
              <div key={label} className="verdict-dim-chip">
                <span className="verdict-dim-label">{label}</span>
                <span className="verdict-dim-val">{Math.round(val * 100)}%</span>
              </div>
            ),
          )}
        </div>
        <div className="reasoning">
          <span className="reasoning-label">Judge&rsquo;s verdict</span>
          {v.reasoning}
        </div>
        {run.result.runError && (
          <div className="reasoning" style={{ color: "var(--fail)" }}>
            run error: {run.result.runError}
          </div>
        )}

        {run.result.conversation && run.result.conversation.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "0 0 8px" }}>
              conversation ({run.result.conversation.length} turns)
            </div>
            <div className="conversation-list">
              {run.result.conversation.map((turn, i) => (
                <div key={i} className={`conversation-turn ${turn.speaker}`}>
                  <span className="conversation-speaker">{turn.speaker === "agent" ? "agent" : "user"}</span>
                  {turn.text}
                </div>
              ))}
            </div>
          </>
        )}

        <div className="section-label" style={{ padding: "0 0 8px" }}>
          what happened — {run.result.copilotRoundTrips.length} real round trip{run.result.copilotRoundTrips.length === 1 ? "" : "s"}{" "}
          ({run.result.copilotRoundTrips.filter((t) => summarizeRoundTrip(t.requestBody, t.responseBody).kind === "verb").length} real actions, the rest
          Planner/Critic checks — dashed badges below)
        </div>
        <div className="trace-step-list">
          {run.result.copilotRoundTrips.length === 0 ? (
            <div className="trace-step-empty">No real action was taken this trial.</div>
          ) : (
            run.result.copilotRoundTrips.map((trip, i) => <RoundTripStep key={i} trip={trip} index={i} />)
          )}
        </div>

        {run.result.voiceLatencies && (
          <>
            <div className="section-label" style={{ padding: "14px 0 6px" }}>
              voice latencies
            </div>
            <pre className="json-block" style={{ marginBottom: 14 }}>
              {json(run.result.voiceLatencies)}
            </pre>
          </>
        )}

        <details className="trace-step-raw" style={{ marginTop: 14 }}>
          <summary>view real final state (what verify.path actually returned)</summary>
          <pre className="json-block">{json(run.result.finalState)}</pre>
        </details>
      </div>
    </details>
  );
}

export default function TrialGroupPage({ params }: { params: { trialGroup: string } }) {
  const runs = getTrialGroup(params.trialGroup);
  if (runs.length === 0) notFound();

  const first = runs[0];
  const passK = runs.every((r) => r.verdict.pass);

  return (
    <>
      <a className="back-link" href="/">
        ← back to overview
      </a>
      <h1>{first.scenarioId}</h1>
      <p className="subtitle">
        {first.transport} · {first.commit} · trial group {first.trialGroup.slice(0, 8)} ·{" "}
        <span className={`pill ${passK ? "pill-pass" : "pill-fail"}`} style={{ marginLeft: 4 }}>
          pass^{runs.length}: {passK ? "PASS" : "FAIL"}
        </span>
      </p>
      {runs.map((run) => (
        <TrialCard key={run.id} run={run} total={runs.length} />
      ))}
    </>
  );
}

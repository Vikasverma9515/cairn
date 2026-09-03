import { notFound } from "next/navigation";
import { getTrialGroup } from "../../../lib/data";
import type { StoredRun } from "@cairnvibe/evals/store";
import type { CopilotRoundTrip, VoiceFrame } from "@cairnvibe/evals/trace";

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function RoundTripStep({ trip, index }: { trip: CopilotRoundTrip; index: number }) {
  const ms = trip.respondedAt - trip.requestedAt;
  return (
    <details className="step">
      <summary>
        round trip {index + 1} — {ms}ms
      </summary>
      <div className="section-label">request</div>
      <pre className="json-block">{json(trip.requestBody)}</pre>
      <div className="section-label">response</div>
      <pre className="json-block">{json(trip.responseBody)}</pre>
    </details>
  );
}

function VoiceFrameStep({ frame, index }: { frame: VoiceFrame; index: number }) {
  return (
    <details className="step">
      <summary>
        frame {index + 1} — {frame.direction}
      </summary>
      <pre className="json-block">{json(frame.data)}</pre>
    </details>
  );
}

function TrialCard({ run, index, total }: { run: StoredRun; index: number; total: number }) {
  const v = run.verdict;
  return (
    <details className="trace" open={total <= 3}>
      <summary>
        <span>
          trial {run.trialIndex}/{total} — {run.result.transport}
        </span>
        <span className={`pill ${v.pass ? "pill-pass" : "pill-fail"}`}>{v.pass ? "pass" : "fail"}</span>
      </summary>
      <div className="trace-body">
        <div className="verdict-grid" style={{ marginBottom: 14 }}>
          <span>taskSuccess {v.taskSuccess.toFixed(2)}</span>
          <span>efficiency {v.efficiency.toFixed(2)}</span>
          <span>correctness {v.correctness.toFixed(2)}</span>
          <span>safety {v.safety.toFixed(2)}</span>
          {v.latency !== null && <span>latency {v.latency.toFixed(2)}</span>}
        </div>
        <div className="reasoning">{v.reasoning}</div>
        {run.result.runError && (
          <div className="reasoning" style={{ color: "var(--fail)" }}>
            run error: {run.result.runError}
          </div>
        )}
        <div className="section-label" style={{ padding: "0 0 6px" }}>
          copilot round trips ({run.result.copilotRoundTrips.length})
        </div>
        <div className="step-list" style={{ marginBottom: 14 }}>
          {run.result.copilotRoundTrips.map((trip, i) => (
            <RoundTripStep key={i} trip={trip} index={i} />
          ))}
        </div>
        {run.result.voiceFrames && run.result.voiceFrames.length > 0 && (
          <>
            <div className="section-label" style={{ padding: "0 0 6px" }}>
              voice frames ({run.result.voiceFrames.length})
            </div>
            <div className="step-list" style={{ marginBottom: 14 }}>
              {run.result.voiceFrames.map((frame, i) => (
                <VoiceFrameStep key={i} frame={frame} index={i} />
              ))}
            </div>
          </>
        )}
        {run.result.voiceLatencies && (
          <>
            <div className="section-label" style={{ padding: "0 0 6px" }}>
              voice latencies
            </div>
            <pre className="json-block" style={{ marginBottom: 14 }}>
              {json(run.result.voiceLatencies)}
            </pre>
          </>
        )}
        <div className="section-label" style={{ padding: "0 0 6px" }}>
          final state
        </div>
        <pre className="json-block">{json(run.result.finalState)}</pre>
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
        ← back to scenarios
      </a>
      <h1>{first.scenarioId}</h1>
      <p className="subtitle">
        {first.transport} · {first.commit} · trial group {first.trialGroup.slice(0, 8)} ·{" "}
        <span className={`pill ${passK ? "pill-pass" : "pill-fail"}`} style={{ marginLeft: 4 }}>
          pass^{runs.length}: {passK ? "PASS" : "FAIL"}
        </span>
      </p>
      {runs.map((run, i) => (
        <TrialCard key={run.id} run={run} index={i} total={runs.length} />
      ))}
    </>
  );
}

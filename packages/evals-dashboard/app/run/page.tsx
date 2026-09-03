import { listRuns } from "../../lib/run";
import { triggerRun } from "./actions";

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

export default function RunTriggerPage() {
  const runs = listRuns();

  return (
    <>
      <h1>Run suite</h1>
      <p className="subtitle">Kicks off the real <code>npm run evals</code> CLI against a live playground app — for dev convenience alongside the terminal.</p>
      <form action={triggerRun} style={{ marginBottom: 28 }}>
        <button type="submit" className="run-button">
          Run suite now
        </button>
      </form>

      {runs.length === 0 ? (
        <div className="empty-state">No runs triggered from this dashboard yet.</div>
      ) : (
        <>
          <h2>Past runs</h2>
          <div className="card-list">
            {runs.map((r) => (
              <a key={r.id} className="card" href={`/run/${r.id}`}>
                <div className="card-top">
                  <div>
                    <div className="card-title">{r.id.slice(0, 8)}</div>
                    <div className="card-meta">{relativeTime(r.startedAt)}</div>
                  </div>
                  <span className={`pill ${r.finishedAt === null ? "pill-neutral" : r.exitCode === 0 ? "pill-pass" : "pill-fail"}`}>
                    {r.finishedAt === null ? "running" : r.exitCode === 0 ? "done" : `exit ${r.exitCode}`}
                  </span>
                </div>
              </a>
            ))}
          </div>
        </>
      )}
    </>
  );
}

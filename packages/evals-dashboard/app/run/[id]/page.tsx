import { notFound } from "next/navigation";
import { readRunLog } from "../../../lib/run";

export const dynamic = "force-dynamic";

export default function RunLogPage({ params }: { params: { id: string } }) {
  const entry = readRunLog(params.id);
  if (!entry) notFound();

  const running = entry.meta.finishedAt === null;

  return (
    <>
      <a className="back-link" href="/run">
        ← back to runs
      </a>
      <h1>Run {entry.meta.id.slice(0, 8)}</h1>
      <p className="subtitle">
        started {new Date(entry.meta.startedAt).toLocaleString()} ·{" "}
        {running ? (
          <span className="pill pill-neutral">running — refresh to update</span>
        ) : (
          <span className={`pill ${entry.meta.exitCode === 0 ? "pill-pass" : "pill-fail"}`}>
            exited {entry.meta.exitCode} {entry.meta.exitCode === 0 ? "(success)" : ""}
          </span>
        )}{" "}
        <a href={`/run/${entry.meta.id}`} style={{ marginLeft: 6, fontSize: 12, color: "var(--accent)" }}>
          ↻ refresh
        </a>
      </p>
      <pre className="json-block run-log">{entry.log || "(no output yet)"}</pre>
    </>
  );
}

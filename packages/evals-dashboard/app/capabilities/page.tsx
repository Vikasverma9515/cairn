import { getCapabilityBreakdown } from "../../lib/data";
import { CAPABILITY_DESCRIPTIONS } from "@cairnvibe/evals/taxonomy";

export const dynamic = "force-dynamic";

export default function CapabilitiesPage() {
  const rows = getCapabilityBreakdown();
  const anyData = rows.some((r) => r.total > 0);

  return (
    <>
      <h1>Capability breakdown</h1>
      <p className="subtitle">
        Aggregate pass^k rate per taxonomy dimension, across every scenario's most recent trial group — the direct answer to
        &ldquo;how good are we at X.&rdquo;
      </p>
      {!anyData ? (
        <div className="empty-state">
          No runs recorded yet. Run <code>npm run evals</code> in <code>packages/evals</code> against a live playground app to populate this
          dashboard.
        </div>
      ) : (
        <div className="breakdown-grid">
          {rows.map((row) => {
            const rate = row.total > 0 ? row.passed / row.total : null;
            return (
              <div key={row.tag} className="breakdown-card">
                <div className="breakdown-name">{row.tag}</div>
                <div className="breakdown-desc">{CAPABILITY_DESCRIPTIONS[row.tag]}</div>
                {row.total === 0 ? (
                  <span className="pill pill-neutral">no coverage yet</span>
                ) : (
                  <>
                    <div className="breakdown-bar-track">
                      <div className="breakdown-bar-fill" style={{ width: `${Math.round((rate ?? 0) * 100)}%` }} />
                    </div>
                    <div className="breakdown-stat">
                      {row.passed}/{row.total} scenario groups passing
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

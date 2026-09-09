"use client";

import { useState } from "react";

export interface TrendPoint {
  commit: string;
  ranAt: string;
  overallScore: number;
  passRate: number;
}

/** A real, hand-built line chart (no library, per the dataviz skill — this
 * is a single series, plain SVG is the right tool) showing overall score
 * across every commit that's recorded a run. One hue (the accent, already
 * used everywhere else in this dashboard for magnitude) since this is one
 * series, not several identities — no categorical palette needed. Ships
 * with a real hover crosshair + tooltip (the skill's own "interactivity by
 * default" rule for anything more than a bare stat tile). */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (points.length === 0) return null;

  const width = 900;
  const height = 220;
  const padLeft = 36;
  const padRight = 16;
  const padTop = 16;
  const padBottom = 28;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const xFor = (i: number) => (points.length === 1 ? padLeft + plotW / 2 : padLeft + (i / (points.length - 1)) * plotW);
  const yFor = (score: number) => padTop + plotH - (score / 100) * plotH;

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.overallScore).toFixed(1)}`).join(" ");
  const gridLines = [0, 25, 50, 75, 100];

  const hovered = hoverIndex !== null ? points[hoverIndex] : null;
  const hoverX = hoverIndex !== null ? xFor(hoverIndex) : 0;

  // Explicit "en-US" — see page.tsx's own fmtDate for the real hydration-mismatch this avoids.
  const dateFmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Overall score trend across runs">
        {gridLines.map((g) => (
          <g key={g}>
            <line x1={padLeft} x2={width - padRight} y1={yFor(g)} y2={yFor(g)} stroke="var(--border)" strokeWidth={1} />
            <text x={padLeft - 8} y={yFor(g)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill="var(--text-faint)" fontFamily="var(--mono)">
              {g}
            </text>
          </g>
        ))}

        <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {points.map((p, i) => (
          <circle
            key={p.commit}
            cx={xFor(i)}
            cy={yFor(p.overallScore)}
            r={hoverIndex === i ? 5 : 3.5}
            fill="var(--bg)"
            stroke="var(--accent)"
            strokeWidth={2}
          />
        ))}

        {points.length > 1 &&
          points.map((p, i) => (
            <text key={p.commit} x={xFor(i)} y={height - 8} textAnchor="middle" fontSize={10} fill="var(--text-faint)" fontFamily="var(--mono)">
              {dateFmt(p.ranAt)}
            </text>
          ))}

        {hovered && <line x1={hoverX} x2={hoverX} y1={padTop} y2={padTop + plotH} stroke="var(--text-faint)" strokeWidth={1} strokeDasharray="3 3" />}

        {/* Hit targets — wider than the marks themselves, per the skill's own interaction spec */}
        {points.map((p, i) => (
          <rect
            key={p.commit}
            x={xFor(i) - (plotW / Math.max(points.length, 1)) / 2}
            y={padTop}
            width={plotW / Math.max(points.length, 1)}
            height={plotH}
            fill="transparent"
            onMouseEnter={() => setHoverIndex(i)}
            onMouseLeave={() => setHoverIndex(null)}
          />
        ))}
      </svg>
      <div
        className={`chart-tooltip ${hovered ? "visible" : ""}`}
        style={hovered ? { left: `${(hoverX / width) * 100}%`, top: `${(yFor(hovered.overallScore) / height) * 100}%` } : undefined}
      >
        {hovered && (
          <>
            <strong>{hovered.overallScore}</strong> · {hovered.commit} · {dateFmt(hovered.ranAt)} · pass {Math.round(hovered.passRate * 100)}%
          </>
        )}
      </div>
    </div>
  );
}

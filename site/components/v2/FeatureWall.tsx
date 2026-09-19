"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import DriftWall from "./DriftWall";
import { Ico, I } from "./icons";

/* ------------------------------------------------------------------ */
/* Tile building blocks                                                */
/* ------------------------------------------------------------------ */

function Tile({ icon, title, body, children }: { icon: ReactNode; title: string; body: ReactNode; children: ReactNode }) {
  return (
    <span className="cx-t">
      <span className="cx-t-head">
        <span className="cx-t-ico">
          <Ico>{icon}</Ico>
        </span>
        <b>{title}</b>
      </span>
      <span className="cx-t-body">{body}</span>
      <span className="cx-t-viz">{children}</span>
    </span>
  );
}

function Chips({ items, hot = [] }: { items: string[]; hot?: string[] }) {
  return (
    <span className="cx-t-chips">
      {items.map((c) => (
        <span key={c} className={hot.includes(c) ? "hot" : ""}>
          {c}
        </span>
      ))}
    </span>
  );
}

function Mini({ children }: { children: ReactNode }) {
  return <span className="cx-t-mini">{children}</span>;
}

/* static bars: no per-bar animation, so a wall of tiles stays cheap */
const BARS = Array.from({ length: 22 }, (_, i) => Math.round(24 + Math.abs(Math.sin(i * 0.8)) * 70));

/* ------------------------------------------------------------------ */
/* The ten tiles                                                       */
/* ------------------------------------------------------------------ */

const ITEMS = [
  {
    title: "An agent that plans, acts and checks",
    content: (
      <Tile icon={I.sparkles} title="Plans, acts and checks" body="A planner splits the request into steps, the agent runs each with one of 16 fixed verbs, and a critic verifies every one.">
        <Chips items={["explain", "read", "do", "click", "fill", "navigate", "tour"]} hot={["read", "do", "click", "fill"]} />
      </Tile>
    ),
  },
  {
    title: "Real voice mode",
    content: (
      <Tile icon={I.mic} title="Real voice mode" body="A persistent WebSocket: streaming starts in about 1.5s, and talking over it stops it immediately.">
        <span className="cx-t-wave" aria-hidden="true">
          {BARS.map((h, i) => (
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </span>
      </Tile>
    ),
  },
  {
    title: "Any framework, any stack",
    content: (
      <Tile
        icon={I.globe}
        title="Any framework, any stack"
        body={
          <>
            <code>&lt;Copilot/&gt;</code> for React, <code>&lt;cairn-widget&gt;</code> for everything else.
          </>
        }
      >
        <Chips items={["React", "Next.js", "Vue", "Angular", "Svelte", "Plain HTML"]} />
      </Tile>
    ),
  },
  {
    title: "Safe by design",
    content: (
      <Tile icon={I.shield} title="Safe by design" body="It can only take actions you registered, checked on the server against a fixed schema.">
        <Mini>
          <span className="c">do</span> <span className="v">archiveInvoice</span>(id) <span className="ok">✓ registered</span>
          <br />
          <span className="c">do</span> <span className="v">deleteAllUsers</span>() <span className="no">✗ blocked</span>
          <br />
          <span className="c">eval</span>(&quot;…&quot;) <span className="no">✗ never allowed</span>
        </Mini>
      </Tile>
    ),
  },
  {
    title: "Capability tiers",
    content: (
      <Tile icon={I.lock} title="Capability tiers" body="Cap what the agent may do, independent of which actions you have registered.">
        <span className="cx-t-seg">
          <span>explain</span>
          <span>guide</span>
          <span className="on">act</span>
        </span>
      </Tile>
    ),
  },
  {
    title: "Real, tiered memory",
    content: (
      <Tile icon={I.db} title="Real, tiered memory" body="Turn history, an explicit remember, and long-term facts recalled only when relevant, in a real SQLite store.">
        <Chips items={["turn history", "remember(…)", "long-term facts", "SQLite"]} hot={["SQLite"]} />
      </Tile>
    ),
  },
  {
    title: "Learns your platform as it goes",
    content: (
      <Tile icon={I.book} title="Learns as it goes" body="A completed task can leave behind a small, verified Skill: a fact about your app, never user data.">
        <Mini>
          <span className="c">// skill saved</span>
          <br />
          <span className="v">archive-invoice</span>
          <br />
          <span className="ok">✓ verified · reused next time</span>
        </Mini>
      </Tile>
    ),
  },
  {
    title: "Works on apps you didn't write",
    content: (
      <Tile
        icon={I.search}
        title="Works on apps you didn't write"
        body={
          <>
            Point <code>cairn build</code> at a live URL and a headless browser maps it.
          </>
        }
      >
        <Mini>
          <span className="c">$</span> cairn build https://app.com
          <br />
          <span className="ok">✓</span> 14 pages · 52 elements
        </Mini>
      </Tile>
    ),
  },
  {
    title: "Session-aware key rotation",
    content: (
      <Tile icon={I.shield} title="Key rotation" body="A confirmed-dead API key is excluded for the process's life; a rate limit retries on another key.">
        <Mini>
          <span className="c">key-1</span> <span className="no">✗ dead · excluded</span>
          <br />
          <span className="c">key-2</span> <span className="ok">✓ active</span>
          <br />
          <span className="c">key-3</span> <span className="v">standby</span>
        </Mini>
      </Tile>
    ),
  },
  {
    title: "Ten commands, the whole surface",
    content: (
      <Tile icon={I.tool} title="Ten commands, that's it" body="Set up, scan, build, diff and document your app from one small CLI.">
        <Chips items={["cairn setup", "cairn build", "cairn scan", "cairn diff", "cairn docs"]} hot={["cairn setup"]} />
      </Tile>
    ),
  },
];

/* ------------------------------------------------------------------ */
/* Responsive wall                                                     */
/* ------------------------------------------------------------------ */

const CONFIGS = {
  desktop: { columns: 5, tileWidth: 360, tileHeight: 250, gap: 18, tilt: 16, turn: -14, depth: 120, speed: 32, height: 780 },
  laptop: { columns: 3, tileWidth: 350, tileHeight: 250, gap: 16, tilt: 15, turn: -12, depth: 100, speed: 30, height: 720 },
  tablet: { columns: 2, tileWidth: 320, tileHeight: 246, gap: 16, tilt: 12, turn: -8, depth: 70, speed: 28, height: 660 },
  mobile: { columns: 1, tileWidth: 292, tileHeight: 268, gap: 14, tilt: 8, turn: -4, depth: 40, speed: 26, height: 580 },
} as const;

type Size = keyof typeof CONFIGS;

const pickSize = (w: number): Size => (w < 560 ? "mobile" : w < 900 ? "tablet" : w < 1240 ? "laptop" : "desktop");

export default function FeatureWall() {
  const [size, setSize] = useState<Size>("desktop");

  useEffect(() => {
    const pick = () => setSize(pickSize(window.innerWidth));
    pick();
    window.addEventListener("resize", pick);
    return () => window.removeEventListener("resize", pick);
  }, []);

  const c = CONFIGS[size];
  const items = useMemo(() => ITEMS, []);

  return (
    <div className="cx-wall" style={{ height: c.height }}>
      <DriftWall
        items={items}
        columns={c.columns}
        tileWidth={c.tileWidth}
        tileHeight={c.tileHeight}
        gap={c.gap}
        radius={20}
        tilt={c.tilt}
        turn={c.turn}
        perspective={1200}
        depth={c.depth}
        speed={c.speed}
        direction="up"
        variance={0.45}
        parallax={0.5}
        pauseOnHover={true}
        lift={70}
        fade={0.6}
        dim={0.92}
        overlayColor="#000000"
      />
    </div>
  );
}

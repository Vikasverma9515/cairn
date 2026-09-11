"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { TLine } from "./Term";

type Step = {
  title: string;
  desc: ReactNode;
  label: string;
  lines: TLine[];
};

const STEPS: Step[] = [
  {
    title: "Detects your framework",
    desc: "Finds Next.js, installs the three packages — with a real retry prompt if npm hiccups, not a dead end.",
    label: "terminal — install",
    lines: [
      [{ cls: "c1", text: "$ npx @cairnvibe/indexer setup" }],
      [{ cls: "c3", text: "✓ detected Next.js (App Router)" }],
      [{ cls: "c3", text: "✓ installed @cairnvibe/core, indexer, sdk" }],
      [{ cls: "c1", text: "  (a failed install gets a real retry prompt, not a dead end)" }],
    ],
  },
  {
    title: "Asks three skippable questions",
    desc: "LLM provider, its API key (masked as you type, never echoed), and whether you want voice.",
    label: "terminal — setup prompts",
    lines: [
      [
        { cls: "c1", text: "? Which LLM provider?" },
        { text: "  " },
        { cls: "c2", text: "› Anthropic" },
      ],
      [
        { cls: "c1", text: "? Paste your API key:" },
        { text: "  " },
        { cls: "c2", text: "› ••••••••••••••••••" },
      ],
      [{ cls: "c1", text: "  (masked as you type, never echoed in plain text)" }],
      [
        { cls: "c1", text: "? Enable voice mode (Deepgram)?" },
        { text: "  " },
        { cls: "c2", text: "› n" },
      ],
    ],
  },
  {
    title: "Wires itself into your app",
    desc: (
      <>
        A real AST edit to <code>app/layout.tsx</code> — never a blind string
        splice.
      </>
    ),
    label: "terminal — auto-wired",
    lines: [
      [{ cls: "c3", text: "✓ generated components/CairnCopilot.tsx" }],
      [{ cls: "c3", text: "✓ wired <CairnCopilot/> into app/layout.tsx" }],
      [{ cls: "c3", text: "✓ added transpilePackages to next.config.*" }],
      [{ cls: "c1", text: "  (can't confidently parse a file? it prints manual steps" }],
      [{ cls: "c1", text: "   instead of guessing at your code)" }],
    ],
  },
  {
    title: "Builds the manifest once",
    desc: "Reads your real source. No key yet? It skips this step cleanly instead of failing your build.",
    label: "ui-manifest.json",
    lines: [
      [{ cls: "c1", text: "↻ building ui-manifest.json…" }],
      [{ cls: "c3", text: "✓ manifest built — 14 pages, 52 elements mapped" }],
      [{ cls: "c1", text: "  no key configured yet? this step skips cleanly — set env" }],
      [{ cls: "c1", text: "  vars on your host, then rebuild (see Deploy below)" }],
    ],
  },
  {
    title: "You're already running",
    desc: (
      <>
        A <code>prebuild</code> script keeps the manifest current on every
        future build — no extra step, ever.
      </>
    ),
    label: "terminal — you're running",
    lines: [
      [{ cls: "c3", text: '✓ added a "prebuild" script to package.json' }],
      [{ cls: "c1", text: "$ npm run dev" }],
      [{ cls: "c1", text: "# build and redeploy any time after — the manifest stays" }],
      [{ cls: "c1", text: "# current on its own, with no extra pipeline step" }],
    ],
  },
];

export default function InstallGuide() {
  const [active, setActive] = useState(0);
  const playedRef = useRef(false);
  const guideRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopAuto() {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
  }

  function startAuto() {
    stopAuto();
    timerRef.current = setInterval(() => {
      setActive((a) => (a + 1) % STEPS.length);
    }, 4200);
  }

  useEffect(() => {
    const el = guideRef.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      startAuto();
      return () => stopAuto();
    }
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !playedRef.current) {
            playedRef.current = true;
            startAuto();
          }
        });
      },
      { threshold: 0.35 }
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      stopAuto();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectStep(i: number) {
    setActive(i);
    startAuto();
  }

  const step = STEPS[active];

  return (
    <div
      className="install-guide"
      id="install-guide"
      ref={guideRef}
      onMouseEnter={stopAuto}
      onMouseLeave={startAuto}
    >
      <div className="install-steps">
        {STEPS.map((s, i) => (
          <button
            key={s.title}
            type="button"
            className={`install-step${i === active ? " active" : ""}`}
            onClick={() => selectStep(i)}
          >
            <span className="is-num">{i + 1}</span>
            <span className="is-body">
              <strong>{s.title}</strong>
              <small>{s.desc}</small>
            </span>
          </button>
        ))}
      </div>
      <div className="install-panel chrome">
        <div className="chrome-bar">
          <i></i>
          <i></i>
          <i></i>
          <span>{step.label}</span>
        </div>
        <pre className="type-lines" key={active}>
          {step.lines.map((line, i) => (
            <span key={i} className="tl" style={{ "--d": i } as React.CSSProperties}>
              {line.map((seg, j) =>
                seg.cls ? (
                  <span key={j} className={seg.cls}>
                    {seg.text}
                  </span>
                ) : (
                  seg.text
                )
              )}
            </span>
          ))}
          <span className="type-cursor"></span>
        </pre>
      </div>
    </div>
  );
}

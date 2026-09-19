"use client";

import { useEffect, useState } from "react";
import FolderFloat from "./FolderFloat";
import { Ico, I } from "./icons";

const STEPS = [
  { value: "packages", label: "Installs the packages", detail: "core, indexer and sdk, with a real retry prompt if it fails." },
  { value: "questions", label: "Asks a few questions", detail: "Which LLM provider and its key, masked as you type. Voice on request. Every question is skippable." },
  { value: "widget", label: "Wires the widget in", detail: "A real AST edit adds the widget to your layout, and it never touches a file it can't confidently parse." },
  { value: "bundler", label: "Configures your bundler", detail: "Adds transpilePackages to next.config so the package builds cleanly." },
  { value: "manifest", label: "Builds your manifest", detail: "Once, with a spinner, if you gave a key. That's the map the agent works from." },
];

export default function InstallFolder() {
  const [picked, setPicked] = useState(0);
  const [compact, setCompact] = useState(false);

  // On phones the cloud of notes must fit a narrow stage, so it packs into more rows.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 560px)");
    const sync = () => setCompact(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  const step = STEPS[picked];

  return (
    <div className="cx-if">
      <div className="cx-if-stage">
        <FolderFloat
          items={STEPS.map(({ value, label }) => ({ value, label }))}
          label="One command"
          sublabel="5 things happen"
          trigger="click"
          defaultOpen
          closeOnSelect={false}
          physics
          drift={0.5}
          onSelect={(value: string) => setPicked(Math.max(0, STEPS.findIndex((s) => s.value === value)))}
          folderColor="#2a1d14"
          frontColor="#4a3020"
          paperColor="#ede6da"
          itemColor="#ede6da"
          itemTextColor="#1a0e06"
          labelColor="#ede6da"
          width={compact ? 190 : 230}
          height={compact ? 128 : 150}
          radius={16}
          spread={compact ? 138 : 230}
          lift={30}
          tilt={7}
          flapAngle={34}
          restAngle={16}
          openDuration={560}
          stagger={55}
          bounce={0.35}
        />
        <p className="cx-if-hint">Click the folder to close it. Drag the notes around, or click one.</p>
      </div>

      <div className="cx-if-detail" key={step.value} aria-live="polite">
        <span className="cx-if-num">{picked + 1}</span>
        <div>
          <b>{step.label}</b>
          <span>{step.detail}</span>
        </div>
        <Ico size={18}>{I.check}</Ico>
      </div>
    </div>
  );
}

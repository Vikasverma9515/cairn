"use client";

import { useMemo, useState, type ReactNode } from "react";
// One import per icon: the package's index file has mis-cased internal paths that break on case-sensitive systems (Linux/Vercel).
import CheckmarkCircle02Icon from "@hugeicons/core-free-icons/CheckmarkCircle02Icon";
import ComputerTerminal01Icon from "@hugeicons/core-free-icons/ComputerTerminal01Icon";
import FlashIcon from "@hugeicons/core-free-icons/FlashIcon";
import MapsIcon from "@hugeicons/core-free-icons/MapsIcon";
import Mic01Icon from "@hugeicons/core-free-icons/Mic01Icon";
import PlugSocketIcon from "@hugeicons/core-free-icons/PlugSocketIcon";
import PuzzleIcon from "@hugeicons/core-free-icons/PuzzleIcon";
import Route01Icon from "@hugeicons/core-free-icons/Route01Icon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import BranchedMenu from "./BranchedMenu";
import { Ico, I } from "./icons";

/* ------------------------------------------------------------------ */
/* Visuals                                                             */
/* ------------------------------------------------------------------ */

function MapViz() {
  return (
    <svg viewBox="0 0 300 150" width="100%" role="img" aria-label="Your pages, patterns and actions mapped" style={{ display: "block" }}>
      <g fontFamily="IBM Plex Mono, monospace" fontSize="9.5">
        <g stroke="rgba(237,230,218,.22)" strokeWidth="1" fill="none">
          <path d="M92 40 C120 40 120 24 148 24" />
          <path d="M92 40 C120 40 120 72 148 72" />
          <path d="M92 108 C120 108 120 120 148 120" />
          <path d="M226 24 C246 24 246 48 262 48" />
          <path d="M226 72 C246 72 246 48 262 48" />
        </g>
        <rect x="6" y="26" width="86" height="28" rx="8" fill="#12100e" stroke="rgba(237,230,218,.2)" />
        <text x="49" y="44" textAnchor="middle" fill="#ede6da">/invoices</text>
        <rect x="6" y="94" width="86" height="28" rx="8" fill="#12100e" stroke="rgba(237,230,218,.2)" />
        <text x="49" y="112" textAnchor="middle" fill="#ede6da">/board</text>
        <rect x="148" y="10" width="78" height="28" rx="8" fill="#12100e" stroke="rgba(237,230,218,.2)" />
        <text x="187" y="28" textAnchor="middle" fill="#b9af9f">table-crud</text>
        <rect x="148" y="58" width="78" height="28" rx="8" fill="rgba(224,122,63,.13)" stroke="rgba(224,122,63,.6)" />
        <text x="187" y="76" textAnchor="middle" fill="#f0955a">archiveInvoice</text>
        <rect x="148" y="106" width="78" height="28" rx="8" fill="#12100e" stroke="rgba(237,230,218,.2)" />
        <text x="187" y="124" textAnchor="middle" fill="#b9af9f">kanban</text>
        <rect x="262" y="34" width="34" height="28" rx="8" fill="rgba(125,212,168,.12)" stroke="rgba(125,212,168,.5)" />
        <text x="279" y="52" textAnchor="middle" fill="#7dd4a8">API</text>
      </g>
    </svg>
  );
}

function AskViz() {
  return (
    <div className="cx-how-ask">
      <div className="cx-ask" style={{ marginTop: 0 }}>
        <Ico size={18}>{I.mic}</Ico>
        archive the invoice for Acme Co
        <span className="caret" />
      </div>
      <div className="cx-chips-row">
        <span>Say it out loud</span>
        <span>or type it</span>
        <span>in your own words</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The tour                                                            */
/* ------------------------------------------------------------------ */

type Sub = { value: string; label: string; icon: typeof Mic01Icon; title: string; body: ReactNode; viz: ReactNode };
type Step = { label: string; children: Sub[] };

const STEPS: Step[] = [
  {
    label: "Point it at your app",
    children: [
      {
        value: "run",
        label: "Run one command",
        icon: ComputerTerminal01Icon,
        title: "One command, inside your app",
        body: "It installs the packages, asks which model you want, and wires everything in. There is nothing to configure by hand.",
        viz: (
          <>
            <span className="c"># run this inside your app</span>
            <br />
            <span className="s">npx @cairnvibe/indexer setup</span>
            <br />
            <span className="g">✓</span> detected Next.js (App Router)
            <br />
            <span className="g">✓</span> installed core, indexer, sdk
            <br />
            <span className="g">✓</span> wired &lt;CairnCopilot/&gt; into layout
            <br />
            <span className="g">✓</span> manifest built · 14 pages, 52 elements
          </>
        ),
      },
      {
        value: "source",
        label: "Read source or crawl",
        icon: Search01Icon,
        title: "It reads your source, or crawls the live app",
        body: "Next.js gets the deepest analysis because Cairn reads the source. Any other framework is mapped by crawling the running app with a headless browser.",
        viz: (
          <>
            <span className="c">$</span> <span className="s">cairn build ./my-app</span>
            <br />
            <span className="g">✓</span> read source · routes, forms, handlers
            <br />
            <br />
            <span className="c">$</span> <span className="s">cairn build https://your-app.com</span>
            <br />
            <span className="g">✓</span> headless crawl · any framework
          </>
        ),
      },
      {
        value: "wire",
        label: "Widget wired in",
        icon: PlugSocketIcon,
        title: "The widget is added to your layout for you",
        body: "A real code edit, not a blind text splice. If a file can't be parsed with confidence, Cairn leaves it alone and prints the manual steps instead.",
        viz: (
          <>
            <span className="c">app/layout.tsx</span>
            <br />
            <span className="g">+ import CairnCopilot from &quot;@/components/CairnCopilot&quot;;</span>
            <br />
            <span className="c">&nbsp; …</span>
            <br />
            <span className="g">+ &lt;CairnCopilot /&gt;</span>
            <br />
            <span className="e">→</span> file untouched if it can&apos;t be parsed
          </>
        ),
      },
    ],
  },
  {
    label: "It learns what your app can do",
    children: [
      {
        value: "map",
        label: "Pages and elements",
        icon: MapsIcon,
        title: "Every page and clickable element, mapped",
        body: "Cairn builds a map of what is really on each page, so the agent never guesses at an interface it has not seen.",
        viz: <MapViz />,
      },
      {
        value: "actions",
        label: "The actions behind them",
        icon: FlashIcon,
        title: "The real actions behind the buttons",
        body: "It links what people see to the handlers that do the work, so the agent can use your app's own actions.",
        viz: (
          <>
            <span className="s">/invoices</span>
            <br />
            &nbsp;&nbsp;<span className="e">Invoice</span> {"{ status: "}
            <span className="g">&quot;Paid&quot; | &quot;Overdue&quot; | &quot;Archived&quot;</span>
            {" }"}
            <br />
            &nbsp;&nbsp;<span className="e">archiveInvoice</span>(id) <span className="c">→ app/api/invoices/[id]/route.ts</span>
          </>
        ),
      },
      {
        value: "patterns",
        label: "Patterns and playbooks",
        icon: PuzzleIcon,
        title: "Familiar patterns get a matching playbook",
        body: "Tables, boards and other common layouts are recognised, and each gets a playbook so the agent handles them the way a person would.",
        viz: (
          <>
            <span className="s">/invoices</span>
            <br />
            &nbsp;&nbsp;pattern: <span className="g">table-crud</span> <span className="c">matched, playbook attached</span>
            <br />
            <br />
            <span className="s">/board</span>
            <br />
            &nbsp;&nbsp;pattern: <span className="g">kanban</span> <span className="c">matched, playbook attached</span>
          </>
        ),
      },
    ],
  },
  {
    label: "Customers just ask",
    children: [
      {
        value: "ask",
        label: "Say it or type it",
        icon: Mic01Icon,
        title: "They describe it in their own words",
        body: "Out loud or typed. No menu names to remember, no order of clicks to learn.",
        viz: <AskViz />,
      },
      {
        value: "plan",
        label: "It plans the steps",
        icon: Route01Icon,
        title: "The agent plans, then acts",
        body: "A planner breaks the request into steps, and each one is done with your registered actions.",
        viz: (
          <>
            <span className="c">planner</span> <span className="s">1. find Acme Co&apos;s invoice</span>
            <br />
            <span className="c">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span> <span className="s">2. archive it</span>
            <br />
            <span className="c">step 1</span> <span className="e">→ read</span> invoice-table <span className="c">→ found INV-2201</span>
            <br />
            <span className="c">step 2</span> <span className="e">→ do</span> archiveInvoice(INV-2201)
          </>
        ),
      },
      {
        value: "check",
        label: "It checks its work",
        icon: CheckmarkCircle02Icon,
        title: "Every step is verified before it moves on",
        body: "A critic confirms each step worked, and only then does the agent tell the customer it is done.",
        viz: (
          <>
            <span className="c">critic</span> <span className="g">✓ task 1 complete, advancing</span>
            <br />
            <span className="c">step 2</span> <span className="e">→ do</span> archiveInvoice <span className="g">→ status: Archived</span>
            <br />
            <span className="c">critic</span> <span className="g">✓ task 2 complete, done</span>
            <br />
            <br />
            <span className="c">agent</span> <span className="s">&quot;Archived Acme Co&apos;s invoice.&quot;</span>
          </>
        ),
      },
    ],
  },
];

export default function HowExplorer() {
  const [value, setValue] = useState("run");

  const found = useMemo(() => {
    for (let s = 0; s < STEPS.length; s++) {
      const k = STEPS[s].children.findIndex((c) => c.value === value);
      if (k >= 0) return { step: s, sub: k };
    }
    return { step: 0, sub: 0 };
  }, [value]);

  const step = STEPS[found.step];
  const item = step.children[found.sub];

  return (
    <div className="cx-how">
      <div className="cx-how-menu">
        <p className="cx-how-hint">Pick a step to see it</p>
        <BranchedMenu
          items={STEPS}
          defaultOpen={[0]}
          defaultActive="run"
          value={value}
          onSelect={(v: string) => setValue(v)}
          onToggle={(i: number, isOpen: boolean) => {
            if (isOpen) setValue(STEPS[i].children[0].value);
          }}
          color="#EDE6DA"
          accentColor="#F0955A"
          lineColor="#3a3229"
          width={340}
          rowHeight={42}
          indent={46}
          trunk={14}
          radius={12}
          lineWidth={1.6}
          fontSize={15}
          drawDuration={450}
          foldDuration={320}
        />
      </div>

      <div className="cx-how-panel" key={item.value} aria-live="polite">
        <p className="cx-how-kicker">
          Step {found.step + 1} <span>·</span> {step.label}
        </p>
        <h3>{item.title}</h3>
        <p className="cx-how-body">{item.body}</p>
        <div className="cx-viz">{item.viz}</div>
      </div>
    </div>
  );
}

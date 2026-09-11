import { ChromeBar, TermPre, type TLine } from "./Term";

const traceLines: TLine[] = [
  [
    { cls: "who", text: "you" },
    { text: " " },
    { cls: "say", text: '"find the invoice for Acme Co and archive it"' },
  ],
  [],
  [
    { cls: "tag plan", text: "planner" },
    { text: " 1. find Acme Co's invoice   2. archive it" },
  ],
  [
    { cls: "tag step", text: "step 1" },
    { text: "  " },
    { cls: "arrow", text: "→" },
    { text: " read " },
    { cls: "val", text: "invoice-table" },
    { text: " " },
    { cls: "arrow", text: "→" },
    { text: " found " },
    { cls: "val", text: "INV-2201" },
  ],
  [
    { cls: "tag critic", text: "critic" },
    { text: " " },
    { cls: "ok", text: "✓" },
    { text: " task 1 complete — advancing" },
  ],
  [
    { cls: "tag step", text: "step 2" },
    { text: "  " },
    { cls: "arrow", text: "→" },
    { text: " do " },
    { cls: "val", text: "archiveInvoice(INV-2201)" },
    { text: " " },
    { cls: "arrow", text: "→" },
    { text: " status: " },
    { cls: "val", text: "Archived" },
  ],
  [
    { cls: "tag critic", text: "critic" },
    { text: " " },
    { cls: "ok", text: "✓" },
    { text: " task 2 complete — done" },
  ],
  [],
  [
    { cls: "who", text: "agent" },
    { text: " " },
    { cls: "say", text: '"Archived Acme Co\'s invoice."' },
  ],
];

const verbs = [
  "explain",
  "highlight",
  "open",
  "navigate",
  "tour",
  "do",
  "click",
  "fill",
  "read",
  "call_tool",
  "drag",
  "select",
  "key",
  "scroll",
  "wait_for",
  "batch",
];

export default function Agentic() {
  return (
    <section id="agentic">
      <div className="wrap">
        <p className="kicker">How the agent works</p>
        <h2 style={{ maxWidth: "28ch" }}>
          Plans the steps. Acts. Checks its own work.
        </h2>
        <p className="lede">
          A goal that needs more than one step runs through a real Planner →
          Executor → Critic loop — a genuinely separate pass verifies each
          real result before continuing, replanning, or stopping.
        </p>

        <div className="chrome trace">
          <ChromeBar label="agent trace — realtime & typed, identical" />
          <TermPre lines={traceLines} />
        </div>

        <div className="verb-row" style={{ marginTop: 36 }}>
          {verbs.map((v) => (
            <span className="verb" key={v}>
              {v}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

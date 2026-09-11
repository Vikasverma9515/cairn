import { ChromeBar, TermPre, type TLine } from "./Term";

const step1Lines: TLine[] = [
  [{ cls: "c1", text: "# run this inside your app" }],
  [{ cls: "c2", text: "npx @cairnvibe/indexer setup" }],
  [],
  [{ cls: "c1", text: "✓ detected Next.js (App Router)" }],
  [{ cls: "c1", text: "✓ installed @cairnvibe/core, indexer, sdk" }],
  [{ cls: "c1", text: "✓ wired <CairnCopilot/> into app/layout.tsx" }],
  [{ cls: "c3", text: "✓ manifest built — 14 pages, 52 elements mapped" }],
];

const step2Lines: TLine[] = [
  [{ cls: "c1", text: "/invoices" }],
  [
    { cls: "c2", text: "  Invoice" },
    { text: " { status: " },
    { cls: "c3", text: '"Paid" | "Overdue" | "Archived"' },
    { text: " }" },
  ],
  [
    { cls: "c2", text: "  archiveInvoice" },
    { text: "(id) " },
    { cls: "c1", text: "→ handled by app/api/invoices/[id]/route.ts" },
  ],
  [
    { cls: "c2", text: "  pattern:" },
    { text: " " },
    { cls: "c3", text: "table-crud" },
    { text: " " },
    { cls: "c1", text: "— matched, playbook attached" },
  ],
  [],
  [{ cls: "c1", text: "/board" }],
  [
    { cls: "c2", text: "  pattern:" },
    { text: " " },
    { cls: "c3", text: "kanban" },
    { text: " " },
    { cls: "c1", text: "— matched, playbook attached" },
  ],
];

const step3Lines: TLine[] = [
  [{ cls: "c1", text: "you" }, { text: ' "archive the invoice for Acme Co"' }],
  [
    { cls: "c2", text: "→ read" },
    { text: "   invoice-table  " },
    { cls: "c1", text: "→ found INV-2201" },
  ],
  [
    { cls: "c2", text: "→ do" },
    { text: "     archiveInvoice(INV-2201)  " },
    { cls: "c3", text: "→ status: Archived" },
  ],
  [],
  [{ cls: "c1", text: "agent" }, { text: ' "Archived Acme Co\'s invoice."' }],
];

export default function HowItWorks() {
  return (
    <section id="how">
      <div className="wrap">
        <p className="kicker">How it works</p>
        <h2 style={{ maxWidth: "22ch" }}>Three real steps. Nothing improvised.</h2>
        <p className="lede">
          The agent never guesses at a UI it's never seen — every step below
          works from a real, verified map of your app.
        </p>

        <div className="steps">
          <div className="step">
            <div className="step-text">
              <div className="n">01 — one command</div>
              <h3>Point it at your app</h3>
              <p>
                Reads your real source (or crawls a running app for any
                other framework), maps what's actually clickable, and wires
                the widget into your layout automatically.
              </p>
            </div>
            <div className="chrome term">
              <ChromeBar label="bash" />
              <TermPre lines={step1Lines} />
            </div>
          </div>

          <div className="step">
            <div className="step-text">
              <div className="n">02 — deterministic</div>
              <h3>It learns what your app can actually do</h3>
              <p>
                Real data shapes, real business rules, real handler
                functions — not guesses from button labels. A live scan also
                catches anything rendered dynamically.
              </p>
            </div>
            <div className="chrome term">
              <ChromeBar label="ui-manifest.json" />
              <TermPre lines={step2Lines} />
            </div>
          </div>

          <div className="step">
            <div className="step-text">
              <div className="n">03 — live</div>
              <h3>A customer talks, the agent acts</h3>
              <p>
                One of 16 verbs, re-validated server-side every single time
                — it can only take an action you registered, and it never
                invents a click.
              </p>
            </div>
            <div className="chrome term">
              <ChromeBar label="customer talking to the agent" />
              <TermPre lines={step3Lines} />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

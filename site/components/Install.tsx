import CopyButton from "./CopyButton";
import InstallGuide from "./InstallGuide";
import { ChromeBar, TermPre, linesToText, type TLine } from "./Term";

const installCmdLines: TLine[] = [
  [{ cls: "c1", text: "# run this inside your existing Next.js app" }],
  [{ cls: "c2", text: "npx @cairnvibe/indexer setup" }],
];

const webComponentLines: TLine[] = [
  [{ cls: "c1", text: '<script src="/cairn-widget.js"></script>' }],
  [{ cls: "c2", text: '<cairn-widget endpoint="/api/copilot" persona="Cairn"></cairn-widget>' }],
];

const crawlLines: TLine[] = [
  [{ cls: "c1", text: "# works on any framework's output, no source read needed" }],
  [{ cls: "c2", text: "cairn build http://localhost:3000 --provider groq --out ." }],
];

export default function Install() {
  return (
    <section id="install">
      <div className="wrap">
        <p className="kicker">Install</p>
        <h2>One real command. Five things happen automatically.</h2>
        <p className="lede">
          Works end to end on any framework, live-verified — Next.js gets
          the deeper, AST-based source analysis, and everything else gets
          the same real runtime via a headless-browser crawl instead of a
          source read. Click through the steps below to see exactly what
          happens.
        </p>

        <div className="copybox chrome term">
          <ChromeBar label="bash" />
          <TermPre lines={installCmdLines} />
          <CopyButton text={linesToText(installCmdLines)} />
        </div>

        <InstallGuide />

        <div className="subguide">
          <div className="subguide-head">
            <h4>Not Next.js? Same widget, zero dependencies.</h4>
            <p>
              Vue, Angular, Svelte, or a plain static page — drop in the Web
              Component.
            </p>
          </div>
          <div className="chrome term">
            <ChromeBar label="index.html" />
            <TermPre lines={webComponentLines} />
          </div>
        </div>

        <div className="subguide">
          <div className="subguide-head">
            <h4>Can't read the source at all?</h4>
            <p>
              Point the CLI at a running app instead — it crawls the
              rendered page with a headless browser.
            </p>
          </div>
          <div className="chrome term">
            <ChromeBar label="bash" />
            <TermPre lines={crawlLines} />
          </div>
        </div>

        <div className="uninstall-note">
          <span style={{ color: "var(--stone-faint)" }}>Changed your mind?</span>
          <code>npx cairn remove</code>
          <span>
            undoes all of the above in one command — widget, config edits,
            generated files, packages. Your real <code>.env</code> keys are
            never touched.
          </span>
        </div>

        <p className="kicker" style={{ marginTop: 56 }}>
          Works with
        </p>
        <div className="fw-cluster">
          <span className="fw-badge">
            <span className="dot2"></span>React
          </span>
          <span className="fw-badge">
            <span className="dot2"></span>Next.js
          </span>
          <span className="fw-badge soft">Vue</span>
          <span className="fw-badge soft">Angular</span>
          <span className="fw-badge soft">Svelte</span>
          <span className="fw-badge soft">Plain HTML</span>
          <span className="fw-badge soft">Anthropic</span>
          <span className="fw-badge soft">Groq</span>
          <span className="fw-badge soft">Deepgram</span>
        </div>
      </div>
    </section>
  );
}

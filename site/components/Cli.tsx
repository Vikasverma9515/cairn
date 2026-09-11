const rows: [string, React.ReactNode][] = [
  [
    "cairn setup [dir]",
    "The one-command path — installs, asks skippable questions, wires the widget into your real layout, builds once, sets up auto-rebuild.",
  ],
  [
    "cairn remove [dir]",
    <>
      Undoes a <code>cairn setup</code> install in one command — the widget,
      config edits, generated files, the npm packages. Never touches real
      credentials in <code>.env</code>.
    </>,
  ],
  [
    "cairn update [dir]",
    <>
      Checks core/sdk/indexer against the latest published versions and
      asks before installing — <code>--apply</code> skips the prompt.
    </>,
  ],
  [
    "cairn init <dir>",
    "The manual version of the same scaffolding — no prompts, no installs, no file edits beyond new files.",
  ],
  ["cairn scan <dir>", "L1 only — deterministic, no LLM call, no API key needed."],
  [
    "cairn build <dir>",
    <>
      Full pipeline against Next.js source — writes{" "}
      <code>ui-manifest.json</code>.
    </>,
  ],
  [
    "cairn build <url>",
    "Crawl mode — points at a running app instead of source, works on any framework.",
  ],
  [
    "cairn diff <a> <b>",
    "What changed between two manifests — useful in CI to catch silent drift.",
  ],
  [
    "cairn docs <dir>",
    <>
      Reads an existing manifest and writes a human-readable{" "}
      <code>CAIRN_DOCS.md</code>.
    </>,
  ],
  [
    "cairn webmcp <dir>",
    "Reads a manifest, generates a component that registers your already-traced actions as WebMCP tools for any MCP-compatible agent.",
  ],
];

export default function Cli() {
  return (
    <section id="cli">
      <div className="wrap">
        <p className="kicker">CLI reference</p>
        <h2>Ten commands, that's the whole surface.</h2>
        <table className="cli">
          <tbody>
            <tr>
              <th style={{ width: "1%" }}>Command</th>
              <th className="desc">What it does</th>
            </tr>
            {rows.map(([cmd, desc]) => (
              <tr key={cmd}>
                <td>
                  <code>{cmd}</code>
                </td>
                <td className="desc">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

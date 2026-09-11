export default function Hero() {
  return (
    <div className="grid-bg">
      <header className="hero" id="top">
        <div className="wrap">
          <div style={{ textAlign: "center" }}>
            <span className="eyebrow">
              <span className="dot"></span> Vibe using — not vibe coding
            </span>
          </div>
          <h1 className="hero-title">
            Don't learn the software.
            <br />
            Just{" "}
            <span className="keycap">
              <svg viewBox="0 0 128 128">
                <ellipse cx="64" cy="83" rx="38" ry="17" fill="#1B1815" />
                <ellipse cx="45" cy="79" rx="18" ry="12" fill="#1B1815" />
                <ellipse cx="55" cy="61" rx="27" ry="13" fill="#1B1815" opacity="0.75" />
                <ellipse cx="74" cy="39" rx="17" ry="10" fill="#1B1815" opacity="0.55" />
              </svg>
            </span>{" "}
            <em>tell it</em> what you want.
          </h1>
          <p className="hero-sub">
            Cairn is an agentic AI copilot that lives inside your product and
            actually gets things done for your customer — planning the
            steps, clicking, filling, navigating, or talking, then checking
            its own work — while they just describe what they want.
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#install">
              Get started →
            </a>
            <a
              className="btn btn-ghost"
              href="https://github.com/Vikasverma9515/cairn"
              target="_blank"
              rel="noopener"
            >
              View source on GitHub
            </a>
          </div>
        </div>

        <div className="wrap">
          <div className="proof-strip">
            <div className="proof-item">
              <div className="val">16</div>
              <div className="lbl">fixed verbs — never a raw click it invented</div>
            </div>
            <div className="proof-item">
              <div className="val">~1.5s</div>
              <div className="lbl">to first spoken reply, streamed</div>
            </div>
            <div className="proof-item">
              <div className="val">MIT</div>
              <div className="lbl">open source, live on npm today</div>
            </div>
            <div className="proof-item">
              <div className="val">any</div>
              <div className="lbl">framework — Next.js, or any other</div>
            </div>
          </div>
        </div>
      </header>
    </div>
  );
}

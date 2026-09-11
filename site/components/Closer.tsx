export default function Closer() {
  return (
    <div className="grid-bg">
      <section className="closer" style={{ borderTop: "1px solid var(--line-soft)" }}>
        <div className="wrap">
          <p className="kicker" style={{ justifyContent: "center" }}>
            Vibe using
          </p>
          <h2>
            Stop building onboarding flows. Let people <em>say</em> what
            they want.
          </h2>
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
              Star on GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}

const features = [
  {
    icon: (
      <path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z" />
    ),
    title: "Any framework, any stack",
    body: (
      <>
        React via <code>&lt;Copilot/&gt;</code>, or drop{" "}
        <code>&lt;cairn-widget&gt;</code> into Vue, Angular, Svelte, or a
        plain static page — same widget, zero dependencies.
      </>
    ),
  },
  {
    icon: (
      <>
        <circle cx="12" cy="12" r="10" />
        <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
        <path d="M2 12h20" />
      </>
    ),
    title: "Works on apps you didn't write",
    body: (
      <>
        Point <code>cairn build</code> at a running URL instead of source and
        it crawls the rendered page with a headless browser — any
        framework's output.
      </>
    ),
  },
  {
    icon: (
      <>
        <path d="M12 20h9" />
        <path d="M4 19h1a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2H4" />
        <path d="M13 6h4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-4" />
        <path d="M13 6V4a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v2" />
        <path d="M13 12h4" />
      </>
    ),
    title: "Learns your platform as it goes",
    body: "Every task that genuinely completes can leave behind a small, verified Skill — a real fact about how your app works, never user data — reused next time.",
  },
  {
    icon: (
      <>
        <path d="M12 18V5" />
        <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
        <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
        <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
        <path d="M18 18a4 4 0 0 0 2-7.464" />
        <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
        <path d="M6 18a4 4 0 0 1-2-7.464" />
        <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
      </>
    ),
    title: "Real, tiered memory",
    body: (
      <>
        An explicit <code>remember</code>, a searchable turn history, and
        long-term facts recalled only when relevant — a real SQLite store,
        not just what fits in one request.
      </>
    ),
  },
  {
    icon: (
      <>
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </>
    ),
    title: "Capability tiers",
    body: (
      <>
        <code>explain</code> / <code>guide</code> / <code>act</code> caps
        what the agent is allowed to do, independent of which actions your
        app has registered — dial it per customer, per plan.
      </>
    ),
  },
  {
    icon: (
      <>
        <path d="M20 7h-9" />
        <path d="M14 17H5" />
        <circle cx="17" cy="17" r="3" />
        <circle cx="7" cy="7" r="3" />
      </>
    ),
    title: "Session-aware key rotation",
    body: "A confirmed-dead API key is excluded for the rest of the process's life; a rate limit retries on a different configured key automatically — real reliability, not a single point of failure.",
  },
];

export default function Features() {
  return (
    <section id="features">
      <div className="wrap">
        <p className="kicker">What's actually running underneath</p>
        <h2>Not a demo trick. A real system.</h2>
        <div className="grid">
          {features.map((f) => (
            <div className="card" key={f.title}>
              <div className="ico">
                <svg
                  width="19"
                  height="19"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {f.icon}
                </svg>
              </div>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

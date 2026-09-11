const cards = [
  {
    icon: (
      <path d="M15 7a2 2 0 0 1 2 2m4-2a6 6 0 0 1-7.743 5.743L11 17H9v2H7v2H4a1 1 0 0 1-1-1v-2.586a1 1 0 0 1 .293-.707l5.964-5.964A6 6 0 1 1 21 7z" />
    ),
    title: "Set the key on your host, not in a file you commit",
    body: (
      <>
        Add <code>ANTHROPIC_API_KEY</code>, <code>GROQ_API_KEYS</code>, or{" "}
        <code>GEMINI_API_KEY</code> — pick one provider — as an environment
        variable on Vercel, Netlify, Railway, or wherever you deploy.{" "}
        <code>.env</code>/<code>.env.local</code> stay local and gitignored;
        a real key never belongs in either.
      </>
    ),
  },
  {
    icon: (
      <>
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </>
    ),
    title: "The manifest rebuilds itself — you don't call cairn build",
    body: (
      <>
        Setup added a <code>prebuild</code> script, so{" "}
        <code>ui-manifest.json</code> regenerates on every{" "}
        <code>npm run build</code>. Ship a UI change and redeploy like
        normal — the agent's map of your app stays current with no extra
        pipeline step.
      </>
    ),
  },
  {
    icon: (
      <>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </>
    ),
    title: "First deploy, before a key exists",
    body: "A build with no provider key configured yet skips the manifest step cleanly instead of failing your whole deploy — but the widget won't answer anything until a key is set and you deploy once more.",
  },
  {
    icon: (
      <>
        <path d="M12 19v3" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <rect x="9" y="2" width="6" height="13" rx="3" />
      </>
    ),
    title: "Voice needs a real process, not a function",
    body: (
      <>
        <code>cairn-realtime</code> holds a persistent WebSocket open for
        live conversation — plain serverless functions can't do that.
        Turning voice on means running it as its own small long-lived Node
        process alongside your main app, not inside a serverless route.
      </>
    ),
  },
  {
    icon: (
      <>
        <path d="m17 2 4 4-4 4" />
        <path d="M3 11v-1a4 4 0 0 1 4-4h14" />
        <path d="m7 22-4-4 4-4" />
        <path d="M21 13v1a4 4 0 0 1-4 4H3" />
      </>
    ),
    title: "Rotate keys before you hit a rate limit",
    body: (
      <>
        Pass comma-separated keys to <code>GROQ_API_KEYS</code> or{" "}
        <code>GEMINI_API_KEYS</code> and Cairn round-robins across them
        automatically in production — a confirmed-dead key is excluded for
        the rest of the process, a rate limit just retries on the next one.
      </>
    ),
  },
  {
    icon: (
      <>
        <circle cx="18" cy="18" r="3" />
        <circle cx="6" cy="6" r="3" />
        <path d="M13 6h3a2 2 0 0 1 2 2v7" />
        <path d="M11 18H8a2 2 0 0 1-2-2V9" />
      </>
    ),
    title: "Catch silent drift in CI",
    body: (
      <>
        Run <code>cairn diff &lt;old&gt; &lt;new&gt;</code> against the
        manifest already in your repo before merging. A UI change that
        quietly changes what the agent can see should fail your build, not
        surface as a confused customer in production.
      </>
    ),
  },
];

export default function Deploy() {
  return (
    <section id="deploy">
      <div className="wrap">
        <p className="kicker">Deploy</p>
        <h2 style={{ maxWidth: "26ch" }}>
          Ship it like the rest of your app. Here's what actually needs
          care.
        </h2>
        <p className="lede">
          Cairn isn't a separate service to stand up — it builds and
          deploys inside your own pipeline. These are the six things that
          actually bite people.
        </p>

        <div className="grid">
          {cards.map((c) => (
            <div className="card" key={c.title}>
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
                  {c.icon}
                </svg>
              </div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

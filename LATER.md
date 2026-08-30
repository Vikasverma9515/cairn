# Ideas parked until after Phase 5

(Anything that isn't explain+highlight on Next.js App Router goes here.)

- Pages Router support (`pages/**/*.tsx`) — L1 currently only walks `app/`.
- Interactive elements inside `layout.tsx` (nav bars, etc.) aren't attributed
  to any page in the manifest today — the schema is page-scoped. L1 walks
  layout/route files for reachability only and discards their elements.
- `<Link>` (next/link) isn't traced as an interactive element — only literal
  `<a>` tags are. Same for custom Button components that wrap `<button>`.
- Real `do`-verb execution against the customer's own session auth. Today
  `executeVerbResponse`'s `onDo` is a no-op hook the customer can wire up
  themselves; nothing in this repo runs a write action.
- Failure dashboard (aggregate the `cairn:misses` localStorage log server-side).
- "What changed" diffs between manifest versions.
- Voice input for the Copilot panel.
- Docs generation from the manifest (content already exists there — near-free).
- npm publish, landing page, Show HN / r/reactjs / r/SaaS / dev.to / Product Hunt.

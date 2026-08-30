# Ideas parked

Most of what was originally parked here is now built: Pages Router scanning,
layout-level elements, `<Link>`/`*Button` heuristics, real `do`-verb
execution (with a working archive-invoice demo), the failure dashboard,
manifest diffing, voice input (Deepgram), and docs generation. What's left:

- **Per-instance target disambiguation.** When a page renders the same
  interactive element many times with different data (one "Archive" button
  per invoice row), the manifest only ever has one static entry — static AST
  analysis can't see runtime data. The model only gets bare per-instance ids
  via the request's "visible" list (e.g. "archive-inv-2"), with no label.
  Confirmed live: asked to "archive the Globex Inc invoice" with two
  archive buttons visible, the model correctly refused to guess rather than
  picking the wrong one — safe, but not useful. Fix: have the context
  collector send each visible id's nearby text too, not just the id.
- **`<Link>`/`*Button` detection is a heuristic**, not real component
  resolution — a custom link-like component that doesn't literally render
  `<a>` or match the `Link`/`*Button` naming convention won't be picked up.
- **Pages Router is scanned for routes and reachability**, but the runtime
  SDK and BUILD_PLAN's invariants were designed against App Router; treat
  Pages Router support as "the indexer understands it," not "the whole
  product is Pages-Router-tested."
- npm publish — the packages ship raw `.ts` as `main`; publishing to npm
  needs a real build step to `dist/` first, plus actual npm credentials.
- Landing page, Show HN / r/reactjs / r/SaaS / dev.to / Product Hunt posts —
  need the user's own accounts and explicit go-ahead to actually publish or
  post; not something to do unilaterally.

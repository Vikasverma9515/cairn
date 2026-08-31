---
name: Framework support
about: A framework Cairn doesn't fully understand yet, or a crawl-mode gap on one you're using
title: "Framework support: "
labels: framework-support
---

**Framework and version** (e.g. Vue 3.4, SvelteKit 2, Angular 18):

**What's not working**
- [ ] `cairn build <url>` (crawl mode) can't find routes/elements correctly on this framework
- [ ] `cairn init` doesn't scaffold anything useful for this setup
- [ ] `<cairn-widget>` doesn't mount/work correctly in this framework
- [ ] Something else:

**What you tried**
The actual command(s) you ran and what came back — a `ui-manifest.json`
with missing/wrong pages or elements is exactly the kind of detail that
helps here.

**A minimal reproduction, if you can**
A small app in this framework that shows the gap is the single most
useful thing you can attach — crawl mode in particular is much easier to
debug against something reproducible than a description.

See [ROADMAP.md](../../ROADMAP.md) for the current state of framework
support and known limitations (auth-gated apps, SPA-only client-side
routing) before filing — your gap might already be a documented one, in
which case a 👍 and any extra detail you have is still useful.

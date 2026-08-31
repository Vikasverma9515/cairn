---
name: Feature request
about: Something Cairn should do that it doesn't yet
title: ""
labels: enhancement
---

**What you're trying to do**

**What Cairn does today instead** (if anything)

**Why the current behavior isn't enough**

**Where this would fit** (delete what doesn't apply, or add your own):
- The analyzer (`cairn build`, static or crawl mode)
- The runtime agent (verb resolution, voice, memory, tours)
- The widget (React or Web Component)
- Install/scaffolding (`cairn init`)
- Something new entirely

If you have a rough idea of the implementation, sketch it — this project
has a fixed-verb-enum safety invariant (see `@cairn/core`'s
`VerbResponseSchema`) that most feature ideas need to fit inside, not
work around.

// Real cross-session memory (Phase 5) and self-authored Skills
// (Architecture Pillar 3) for this demo app — closes the real gap
// DEVELOPMENT.md's own Pillar 5 and Skill-half-of-Pillar-3 entries
// flagged: both mechanisms were fully built and unit-tested, but never
// actually wired into a running deployment anywhere, so neither could be
// live-verified against real traffic. Shares this app's own already-
// existing sqlite connection (lib/db.ts) rather than opening a second
// file — the same pattern dashboard-sqlite.ts's own comment already
// documents for this exact file.
import { createSqliteMemoryStore } from "@cairnvibe/sdk/memory-sqlite";
import { createSqliteSkillStore } from "@cairnvibe/sdk/skill-store";
import { db } from "./db";

export const memory = createSqliteMemoryStore(db);
export const skills = createSqliteSkillStore(db);

// Skills are scoped per-DEPLOYMENT (the whole app, shared across every
// user who talks to it — skill-store.ts's own doc comment), never
// per-user — a single fixed scope id is exactly right for this one demo
// deployment, unlike memory's scopeId below, which is genuinely per end
// user.
export const SKILLS_SCOPE_ID = "demo-app";

// This demo has no real login — a fixed scopeId still exercises the real
// memory mechanism end to end (Core capping/eviction, Recall search,
// Archive retrieval) across every visitor sharing this dev server, which
// is exactly what's needed to live-verify it. A real deployment with
// real users would pass each user's own stable id here instead.
export const DEMO_SCOPE_ID = "demo-visitor";

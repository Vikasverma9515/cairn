// Architecture Pillar 3 (Skill half) — the agent writes its own map. After
// a real task completes, the Critic (see plan.ts's CriticVerdictSchema)
// may have flagged one or more genuinely new, verified, platform-
// structural facts along the way. The Formulator (server.ts's
// compileSkill) compiles those into one of these — reused on a LATER,
// similar goal on the SAME platform, instead of rediscovering the same
// facts from zero every time.
//
// Modeled on Anthropic's own Agent Skills format (name + one-line
// description, always cheap to list; full instructions loaded only once a
// task matches) rather than inventing a new shape — the same progressive-
// disclosure mechanism this very session's own Skill tool already uses.
// Deliberately flat and small: this is notes on how a PLATFORM behaves,
// never a script (every Playbook/Skill-suggested step still goes through
// the same element-ladder verification and Critic check as any other
// step — see playbooks.ts's own doc comment for the same invariant).

import { z } from "zod";

export const SkillSchema = z
  .object({
    /** Stable, URL/filename-safe id — see slugifySkillId. */
    id: z.string().min(1),
    /** Short, human name, e.g. "Connecting nodes on the workflow canvas". */
    name: z.string().min(1),
    /** One line — always loaded/listed, even before this Skill's full instructions are. */
    description: z.string().min(1),
    /** The accumulated, real, Critic-verified facts this Skill encodes — never user data, see CriticVerdictSchema.learnedFact's own doc comment for the enforcement point. */
    instructions: z.string().min(1),
    /** Which UI pattern (ui-patterns.ts) this Skill was learned from/applies to, if classified — lets a later turn on a similarly-classified page find it even before matching on goal text. Absent for a goal that didn't classify. */
    pattern: z.string().optional(),
    createdAt: z.string(),
  })
  .strict();
export type Skill = z.infer<typeof SkillSchema>;

/** The cheap, always-listable half of a Skill — id/name/description only,
 * never the full instructions (that's the whole point of progressive
 * disclosure: every Skill's summary stays cheap to include on every
 * request; only a matched Skill's full instructions get inlined). */
export type SkillSummary = Pick<Skill, "id" | "name" | "description" | "pattern">;

/** A real, stable, filename-safe id from a Skill's own name — lowercased,
 * non-alphanumeric runs collapsed to a single hyphen, trimmed. Two Skills
 * with the same name in the same scope collide on purpose (saveSkill
 * upserts) — a re-learned Skill for the same real capability should
 * replace the old one, not accumulate duplicates. */
export function slugifySkillId(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

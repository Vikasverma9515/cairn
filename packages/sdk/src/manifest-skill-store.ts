import { manifestToSkills, type Manifest, type Skill } from "@cairnvibe/core";
import type { SkillStore } from "./skill-store";

/**
 * A skill store that needs no database and no setup: it is filled from the manifest (`manifestToSkills`),
 * so every page, its controls and the ask-first rule are known to the Planner out of the box. Skills the
 * developer adds (`extra`) or the agent learns are kept beside them in memory. (The SQLite store in
 * skill-store.ts is for persistence on a long-lived server; this one also works on serverless hosting.)
 */
export function createManifestSkillStore(manifest: Manifest, extra: Skill[] = []): SkillStore {
  const byScope = new Map<string, Map<string, Skill>>();
  const scope = (id: string) => {
    let skills = byScope.get(id);
    if (!skills) {
      skills = new Map([...manifestToSkills(manifest), ...extra].map((s) => [s.id, s]));
      byScope.set(id, skills);
    }
    return skills;
  };
  return {
    saveSkill(scopeId, skill) {
      scope(scopeId).set(skill.id, skill);
    },
    listSkillSummaries(scopeId) {
      return [...scope(scopeId).values()].map(({ id, name, description, pattern }) => ({ id, name, description, pattern }));
    },
    getSkill(scopeId, id) {
      return scope(scopeId).get(id) ?? null;
    },
  };
}

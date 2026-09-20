// Feature skills written from the manifest itself, so nobody has to hand-write them. `cairn build`
// already produces, for every page, what it is for, when to use it and what each control does; this turns
// that into the playbook the Planner reads before it plans, plus a readable SKILLS.md. Deterministic:
// same manifest in, same skills out, no extra model call.

import type { Element, Manifest, Page } from "./index";
import { slugifySkillId, type Skill } from "./skills";

const CREATED = "1970-01-01T00:00:00.000Z";

/** Words in a request that suggest it involves deleting, rejecting, sending or calling: used on goals, so it is broad. */
const RISKY_WORD_RE = /\b(reject|delete|remove|cancel|archive|terminate|revoke|disconnect|refund|charge|purchase|publish|send|email|call|phone|dial)\b/i;
export function mentionsRiskyAction(text: string): boolean {
  return RISKY_WORD_RE.test(text);
}

/** What a control does when pressed. Matched on the leading action, not on any word, so a search box that mentions "email" is not risky. */
const RISKY_LABEL_VERBS = new Set(["reject", "delete", "remove", "archive", "terminate", "revoke", "disconnect", "refund", "charge", "purchase", "publish", "send", "email", "call", "dial"]);
const RISKY_DOES_RE = /^(rejects?|deletes?|removes?|cancels?|archives?|terminates?|revokes?|disconnects?|refunds?|charges?|purchases?|publishes?|sends?|emails?|calls?|phones?|dials?)\b|^(triggers?|starts?|places?|makes?|initiates?)\b.*\b(call|email|sms|message)\b/i;
const MAX_ELEMENTS_PER_PAGE = 30;
const MAX_TEXT = 220;

const clip = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const firstSentence = (text: string) => clip(text.split(/(?<=[.!?])\s/)[0] ?? text, 180);

function usableElements(page: Page): Element[] {
  const seen = new Set<string>();
  const out: Element[] = [];
  for (const el of page.elements) {
    if (el.confidence < 0.5) continue;
    if (/^unknown/i.test(el.does.trim()) || /no (visible )?label|cannot be determined|purpose (is )?unclear|no handler/i.test(el.does)) continue;
    if (/(\.\.\.|…)$/.test(el.label.trim())) continue; // a button's transient "Calling..." text, not a control
    const label = clip(el.label, 60);
    const key = label.toLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    out.push(el);
    if (out.length >= MAX_ELEMENTS_PER_PAGE) break;
  }
  return out;
}

export function isRiskyElement(el: Pick<Element, "id" | "label" | "does">): boolean {
  // A control described as merely opening, showing or filtering something is not the action its label names
  // (a link labelled "call with 3m elapsed" opens a call's details; it does not place one).
  if (/^(opens?|navigates?|shows?|displays?|links?|goes|takes|filters?|searches?|lists?|views?)\b/i.test(el.does.trim())) return false;
  if (/\b(filter|search query|query|sort order)\b/i.test(el.does)) return false; // "Removes the job filter" changes the view, not the data
  const words = `${el.label} ${el.id}`.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const first = words[0] ?? "";
  if (RISKY_LABEL_VERBS.has(first)) return true;
  if (first === "cancel" && el.label.trim().split(/\s+/).length > 1) return true; // "Cancel Meeting", but not a plain form "Cancel"
  if ((first === "start" || first === "trigger") && words.some((w) => w === "call" || w === "email")) return true; // "start-ai-call"
  if (/(^|-)send-|-email$/.test(el.id)) return true; // "send-result-email"
  return RISKY_DOES_RE.test(el.does.trim());
}

function pageSkill(page: Page): Skill {
  const controls = usableElements(page);
  const lines = [
    `Page: ${page.route}`,
    `What it is for: ${clip(page.purpose, 400)}`,
    `Use it when: ${clip(page.whenToUse, 300)}`,
  ];
  if (controls.length) {
    lines.push("Controls on this page:");
    for (const el of controls) {
      lines.push(`- ${clip(el.label, 60)}: ${clip(el.does, MAX_TEXT)}${isRiskyElement(el) ? " (changes something or contacts someone: ask before pressing)" : ""}`);
    }
  }
  return {
    id: `page-${slugifySkillId(page.route === "/" ? "home" : page.route)}`,
    name: page.title && page.title !== page.route ? page.title : `Page ${page.route}`,
    description: firstSentence(page.purpose),
    instructions: lines.join("\n"),
    createdAt: CREATED,
  };
}

/** One skill per page, one for moving around the app, and one listing the risky controls. */
export function manifestToSkills(manifest: Manifest): Skill[] {
  const pages = manifest.pages.filter((p) => p.purpose && !/^unknown/i.test(p.purpose));
  const skills: Skill[] = [];

  if (pages.length > 1) {
    skills.push({
      id: "navigating-the-app",
      name: "Moving around the app",
      description: `Where each of the ${pages.length} pages is and what it is for.`,
      instructions: ["Use the app's own navigation to change page instead of guessing addresses.", ...pages.map((p) => `- ${p.route}: ${firstSentence(p.purpose)}`)].join("\n"),
      createdAt: CREATED,
    });
  }

  const risky: { page: Page; el: Element }[] = [];
  for (const page of pages) for (const el of usableElements(page)) if (isRiskyElement(el)) risky.push({ page, el });
  if (risky.length) {
    const unique = new Map<string, string>();
    for (const { page, el } of risky) {
      const key = el.label.toLowerCase();
      if (!unique.has(key)) unique.set(key, `- ${clip(el.label, 60)} (${page.route}): ${clip(el.does, 140)}`);
    }
    skills.push({
      id: "irreversible-actions",
      name: "Buttons that change things or contact people: ask before you press",
      description: "Delete, reject, cancel, send, email, call and similar controls change real data or reach a real person, so confirm with the person in chat first.",
      instructions: [
        "Never press one of these on your own initiative. Say which item and which action you are about to take, ask \"Shall I go ahead?\" in plain words, and act only after the person says yes in this conversation.",
        "Reading, searching, filtering, opening things, navigating and filling a form are safe to do straight away. When a request mixes safe and risky steps, do the safe ones first and ask before the risky one.",
        "Controls of this kind in this app:",
        ...unique.values(),
      ].join("\n"),
      createdAt: CREATED,
    });
  }

  for (const page of pages) skills.push(pageSkill(page));
  return skills;
}

/** A readable page of the same skills, written next to the manifest by `cairn build`. */
export function generateSkillsMarkdown(skills: Skill[]): string {
  return [
    "# Agent skills",
    "",
    "Written by `cairn build` from the manifest. The assistant reads the matching skill before it plans a request. Re-run `cairn build` after the UI changes.",
    "",
    ...skills.flatMap((s) => [`## ${s.name}`, "", `_${s.description}_`, "", s.instructions, ""]),
  ].join("\n");
}

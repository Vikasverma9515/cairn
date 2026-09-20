import { describe, expect, it } from "vitest";
import { generateSkillsMarkdown, isRiskyElement, manifestToSkills, mentionsRiskyAction, rankSkills } from "./manifest-skills";
import type { Manifest } from "./index";

const el = (label: string, does: string, confidence = 0.9) => ({ id: label, label, selector: "button", fallbacks: [], does, confidence, evidence: [] });
const manifest = {
  version: "1",
  commit: "x",
  generatedAt: "2026-01-01T00:00:00.000Z",
  dead: [],
  conflicts: [],
  pages: [
    {
      id: "candidates", route: "/dashboard/candidates", file: "a.tsx", title: "Candidates", confidence: 0.9,
      purpose: "Lists every candidate in the pipeline. Lets you search and filter.",
      whenToUse: "Use it to find a candidate.",
      elements: [
        el("Add Candidate", "Opens the new candidate form."),
        el("Add Candidate", "Duplicate that should be dropped."),
        el("Reject", "Rejects the candidate and closes their application."),
        el("a-258", "Unknown: no label.", 0.2),
      ],
    },
    { id: "jobs", route: "/dashboard/jobs", file: "b.tsx", title: "Jobs", confidence: 0.9, purpose: "Shows open positions.", whenToUse: "Review openings.", elements: [] },
  ],
} as unknown as Manifest;

describe("manifestToSkills", () => {
  const skills = manifestToSkills(manifest);

  it("writes one skill per page plus navigation, from the manifest alone", () => {
    expect(skills.map((s) => s.id)).toEqual(expect.arrayContaining(["navigating-the-app", "page-dashboard-candidates", "page-dashboard-jobs"]));
    const candidates = skills.find((s) => s.id === "page-dashboard-candidates")!;
    expect(candidates.name).toBe("Candidates");
    expect(candidates.instructions).toContain("- Add Candidate: Opens the new candidate form.");
  });

  it("drops duplicate, unknown and low-confidence controls", () => {
    const text = skills.find((s) => s.id === "page-dashboard-candidates")!.instructions;
    expect(text.match(/Add Candidate/g)?.length).toBe(1);
    expect(text).not.toContain("a-258");
  });

  it("collects risky controls into an ask-first skill and flags them on their page", () => {
    const safety = skills.find((s) => s.id === "irreversible-actions")!;
    expect(safety.instructions).toContain("Reject (/dashboard/candidates)");
    expect(skills.find((s) => s.id === "page-dashboard-candidates")!.instructions).toContain("Reject: Rejects the candidate and closes their application. (changes something");
  });

  it("is deterministic and renders a readable page", () => {
    expect(manifestToSkills(manifest)).toEqual(skills);
    expect(generateSkillsMarkdown(skills)).toContain("## Candidates");
  });

  it("does not call an ordinary navigation control risky", () => {
    expect(isRiskyElement({ id: "x", label: "Add Candidate", does: "Opens the new candidate form." })).toBe(false);
  });

  it("judges by what the control does, not by a keyword: a search box that mentions email, a form Cancel, a link to a call are safe", () => {
    expect(isRiskyElement({ id: "s", label: "Search name, email, phone...", does: "Filters the candidate list by name, email, or phone." })).toBe(false);
    expect(isRiskyElement({ id: "c", label: "Cancel", does: "Discards the form and returns to the list." })).toBe(false);
    expect(isRiskyElement({ id: "f", label: "All Jobs", does: "Removes the job filter to show candidates across all open jobs." })).toBe(false);
    expect(isRiskyElement({ id: "l", label: "call with m s elapsed", does: "Opens the detail view for a specific live call." })).toBe(false);
  });

  it("recognises the controls that do change things or contact people", () => {
    expect(isRiskyElement({ id: "reject-candidate", label: "Reject", does: "Rejects the candidate." })).toBe(true);
    expect(isRiskyElement({ id: "start-ai-call", label: "start-ai-call", does: "Starts an AI call with the candidate." })).toBe(true);
    expect(isRiskyElement({ id: "send-result-email", label: "send-result-email", does: "Sends a result email." })).toBe(true);
    expect(isRiskyElement({ id: "x", label: "Cancel Meeting", does: "Cancels the scheduled interview." })).toBe(true);
    expect(isRiskyElement({ id: "x", label: "Disconnect HR sender", does: "Disconnects the account." })).toBe(true);
  });

  it("leaves out transient button text and elements the model could not describe", () => {
    const m = { ...manifest, pages: [{ ...manifest.pages[0], elements: [el("Calling...", "Triggers a reminder call."), el("a-158", "This element has no label or handler call in the provided source.", 0.9), el("Reject", "Rejects the candidate.")] }] } as Manifest;
    const text = manifestToSkills(m).find((s) => s.id.startsWith("page-"))!.instructions;
    expect(text).not.toContain("Calling...");
    expect(text).not.toContain("a-158");
    expect(text).toContain("Reject");
  });

  it("mentionsRiskyAction is broad on purpose, for goals", () => {
    expect(mentionsRiskyAction("open candidates and reject the first one")).toBe(true);
    expect(mentionsRiskyAction("go to jobs")).toBe(false);
  });

  it("writes no safety skill when nothing is risky", () => {
    const safe = { ...manifest, pages: [{ ...manifest.pages[1] }] } as Manifest;
    expect(manifestToSkills(safe).some((s) => s.id === "irreversible-actions")).toBe(false);
  });
});

describe("written skills and ranking", () => {
  const written = { id: "feature-dashboard-candidates-reject", name: "Reject a candidate", description: "Close a candidate's application.", instructions: "1. Open the candidate. 2. Press Reject then confirm.", createdAt: "x" };
  const withWritten = { ...manifest, skills: [written] } as Manifest;

  it("puts skills written from the code ahead of the derived page skills", () => {
    const skills = manifestToSkills(withWritten);
    expect(skills[0].id).toBe("feature-dashboard-candidates-reject");
    expect(skills.some((s) => s.id === "page-dashboard-candidates")).toBe(true);
  });

  it("ranks by relevance to the request, and boosts the page the person is on", () => {
    const skills = manifestToSkills(withWritten);
    expect(rankSkills(skills, "reject the first candidate", 2).map((s) => s.id)).toContain("feature-dashboard-candidates-reject");
    expect(rankSkills(skills, "zzzz qqqq")).toEqual([]);
    const boosted = rankSkills(skills, "jobs candidates", 1, ["page-dashboard-jobs"]);
    expect(boosted[0].id).toBe("page-dashboard-jobs");
  });
});

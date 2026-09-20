import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Manifest } from "@cairnvibe/core";
import { buildFeatureSkills, normalizeFeatures, normalizeWorkflows, renderFeatureSkill } from "./l4-skills";
import type { SkillWriterClient, ToolSpec } from "./l4-client";
import { scanL1 } from "./l1-scan";

const featureAnswer = {
  features: [
    {
      name: "Reject a candidate",
      summary: "Closes a candidate's application.",
      useWhen: ["reject someone"],
      requires: ["Be on the candidate's page"],
      steps: [
        { do: "Click Reject", control: "reject-candidate", expect: "A confirm step appears" },
        { do: "Confirm", control: "confirm-reject", expect: "Stage becomes rejected" },
      ],
      apis: [{ kind: "server-action", name: "rejectCandidate", method: "", url: "", purpose: "Sets the stage to rejected" }],
      data: [],
      outcome: "The candidate is rejected.",
      watchOut: ["Cannot be undone"],
      asksFirst: true,
    },
  ],
};

describe("l4 feature skills", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cairn-l4-"));
    fs.mkdirSync(path.join(dir, "app", "actions"), { recursive: true });
    fs.mkdirSync(path.join(dir, "components"), { recursive: true });
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    fs.writeFileSync(path.join(dir, "app", "actions", "candidates.ts"), `export async function rejectCandidate(id: string) { /* supabase.from("candidates").update({ stage: "rejected" }) */ }\n`);
    fs.writeFileSync(path.join(dir, "components", "RejectButton.tsx"), `export function RejectButton() { return <button data-ai="reject-candidate" onClick={() => {}}>Reject</button>; }\n`);
    fs.writeFileSync(path.join(dir, "app", "page.tsx"), `import { RejectButton } from "@/components/RejectButton";\nimport { rejectCandidate } from "@/app/actions/candidates";\nexport default function Page() { rejectCandidate; return <RejectButton />; }\n`);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const manifestFor = (): Manifest =>
    ({
      version: "1", commit: "x", generatedAt: "x", dead: [], conflicts: [],
      pages: [{ id: "home", route: "/", file: "app/page.tsx", title: "Candidate", purpose: "Shows a candidate.", whenToUse: "Review them.", confidence: 0.9, elements: [{ id: "reject-candidate", label: "Reject", selector: "x", fallbacks: [], does: "Rejects the candidate.", confidence: 0.9, evidence: [] }] }],
    }) as unknown as Manifest;

  function fakeClient(answer: unknown = featureAnswer) {
    const calls: { user: string; tool: string }[] = [];
    const client: SkillWriterClient = {
      async callTool(_system: string, user: string, tool: ToolSpec) {
        calls.push({ user, tool: tool.name });
        return answer;
      },
    };
    return { client, calls };
  }

  it("reads the code behind the page (components and server actions) and writes a detailed skill from the answer", async () => {
    const { client, calls } = fakeClient();
    const result = await buildFeatureSkills(dir, scanL1(dir), manifestFor(), client);

    // The model was shown the aliased component's source and the server action, not just the page file.
    expect(calls[0].user).toContain('data-ai="reject-candidate"');
    expect(calls[0].user).toContain("rejectCandidate");
    expect(calls[0].user).toContain("id: reject-candidate | label: Reject");

    const skill = result.skills.find((s) => s.id === "feature-home-reject-a-candidate")!;
    expect(skill.instructions).toContain("1. Click Reject [control: reject-candidate] -> A confirm step appears");
    expect(skill.instructions).toContain("server-action rejectCandidate: Sets the stage to rejected");
    expect(skill.instructions).toContain("get a yes in chat");
    expect(result.failedPages).toEqual([]);
  });

  it("caches a real answer, so a rebuild with unchanged code makes no model call", async () => {
    await buildFeatureSkills(dir, scanL1(dir), manifestFor(), fakeClient().client);
    const second = fakeClient();
    const result = await buildFeatureSkills(dir, scanL1(dir), manifestFor(), second.client);
    expect(second.calls).toHaveLength(0);
    expect(result.cacheHits).toBeGreaterThan(0);
    expect(result.skills).toHaveLength(1);
  });

  it("skips a page whose model call fails instead of failing the build", async () => {
    const failing: SkillWriterClient = { callTool: async () => { throw Object.assign(new Error("bad request"), { status: 400 }); } };
    const result = await buildFeatureSkills(dir, scanL1(dir), manifestFor(), failing);
    expect(result.skills).toEqual([]);
    expect(result.failedPages).toEqual(["/"]);
  });
});

describe("normalizing model answers", () => {
  it("keeps usable features and drops malformed ones without throwing", () => {
    const features = normalizeFeatures({ features: [featureAnswer.features[0], { name: "No steps", steps: [] }, "junk", null] });
    expect(features).toHaveLength(1);
    expect(normalizeFeatures(undefined)).toEqual([]);
    expect(normalizeFeatures({ features: "nope" })).toEqual([]);
  });

  it("needs at least two steps for a workflow", () => {
    expect(normalizeWorkflows({ workflows: [{ name: "One step", summary: "x", steps: [{ page: "/", do: "a", control: "" }] }] })).toEqual([]);
  });

  it("renders a stable id from the route and feature name", () => {
    expect(renderFeatureSkill("/dashboard/jobs/[id]", normalizeFeatures(featureAnswer)[0]).id).toBe("feature-dashboard-jobs-id-reject-a-candidate");
  });
});

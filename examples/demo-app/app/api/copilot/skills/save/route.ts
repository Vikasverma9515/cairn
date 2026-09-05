import { NextResponse } from "next/server";
import { createSkillSaveHandler } from "@cairnvibe/sdk/server";
import { skills, SKILLS_SCOPE_ID } from "../../../../../lib/agent-memory";

const handler = createSkillSaveHandler(skills, SKILLS_SCOPE_ID);

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const result = await handler(body);
  return NextResponse.json(result.body, { status: result.status });
}

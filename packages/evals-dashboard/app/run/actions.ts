"use server";

import { redirect } from "next/navigation";
import { startEvalRun } from "../../lib/run";

export async function triggerRun(): Promise<void> {
  const id = startEvalRun();
  redirect(`/run/${id}`);
}

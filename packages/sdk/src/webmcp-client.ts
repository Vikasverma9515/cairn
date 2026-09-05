// Discovers and calls real tools a page has registered via WebMCP
// (https://webmachinelearning.github.io/webmcp/) — an in-progress web
// standard letting a site expose its own functions as typed, parameterized
// tools ("document.modelContext.registerTool(...)"), running in the page's
// own JS with the user's real session. This is the highest-trust action
// source there is: a real function the app's own developer wrote, with a
// real return value — not a click simulated from static analysis. Almost
// no site has adopted it yet, so this is deliberately a no-op (empty list,
// nothing to call) everywhere it isn't present, not a hard dependency.

import type { WebMcpRiskTier, WebMcpTool } from "@cairnvibe/core";

interface ModelContextTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Architecture Pillar 6 — declared by the page's own tool registration, never invented by Cairn. See WebMcpToolSchema's own doc comment. */
  riskTier?: WebMcpRiskTier;
}

interface ModelContext {
  getTools?: () => Promise<ModelContextTool[]> | ModelContextTool[];
  executeTool?: (tool: ModelContextTool, args: unknown) => Promise<unknown>;
}

function getModelContext(): ModelContext | null {
  if (typeof document === "undefined") return null;
  return (document as unknown as { modelContext?: ModelContext }).modelContext ?? null;
}

/** Bounded the same way LiveElementSchema/CopilotRequestSchema bound the
 * live DOM scan — a hard cap on both count and description length, so a
 * page that registers an unreasonable number of tools (or one with a huge
 * description) can't blow the request payload or the prompt. */
const MAX_TOOLS = 30;
const MAX_DESCRIPTION_LENGTH = 500;

export async function discoverWebMcpTools(): Promise<WebMcpTool[]> {
  const modelContext = getModelContext();
  if (!modelContext?.getTools) return [];

  try {
    const tools = await modelContext.getTools();
    if (!Array.isArray(tools)) return [];
    return tools.slice(0, MAX_TOOLS).map((tool) => ({
      name: String(tool.name),
      description: String(tool.description ?? "").slice(0, MAX_DESCRIPTION_LENGTH),
      inputSchema: tool.inputSchema,
      // Architecture Pillar 6 — passed through only when the page's own
      // registration declared a real "confirm" tier; anything else
      // (absent, or a value that isn't literally "confirm") stays
      // undefined/"safe" — never invented, never widened by a typo.
      riskTier: tool.riskTier === "confirm" ? "confirm" : undefined,
    }));
  } catch {
    // A page's own registerTool()/getTools() implementation throwing is
    // that page's bug, not Cairn's — degrade to "no WebMCP tools" rather
    // than breaking the rest of the turn.
    return [];
  }
}

/**
 * Calls a real WebMCP tool by name — `name` must be one the model was
 * actually shown this turn (server.ts only ever includes tools from this
 * exact request's own discoverWebMcpTools() call), never invented.
 * Returns a plain-text observation for the agent loop to reason about
 * next, the same shape a click/fill/read result already takes.
 *
 * Architecture Pillar 6 (the safety layer) — `confirmTool` is only ever
 * consulted for a tool whose OWN registration declared `riskTier:
 * "confirm"` (never something the model or this call site can widen) — a
 * real-world-effect tool (a payment, a delete, anything hard to undo)
 * that must get a genuine yes from the END USER before it runs, not just
 * the model's own decision to call it. No `confirmTool` provided (a host
 * app that hasn't wired up a confirmation UI) is treated as a decline,
 * never as an implicit yes — the safe default when there's no real way
 * to ask.
 */
export async function executeWebMcpTool(
  name: string,
  args: Record<string, unknown> | undefined,
  confirmTool?: (tool: { name: string; description: string }) => Promise<boolean>,
): Promise<{ ok: boolean; observation: string }> {
  const modelContext = getModelContext();
  if (!modelContext?.getTools || !modelContext.executeTool) {
    return { ok: false, observation: "This page no longer has that tool available." };
  }
  try {
    const tools = await modelContext.getTools();
    const tool = Array.isArray(tools) ? tools.find((t) => t.name === name) : undefined;
    if (!tool) return { ok: false, observation: `No tool named "${name}" is available on this page right now.` };

    if (tool.riskTier === "confirm") {
      const confirmed = confirmTool ? await confirmTool({ name: tool.name, description: tool.description ?? "" }) : false;
      if (!confirmed) {
        return { ok: false, observation: "This action needs the user's real confirmation before it can run, and it wasn't confirmed." };
      }
    }

    const result = await modelContext.executeTool(tool, args ?? {});
    const observation = typeof result === "string" ? result : JSON.stringify(result ?? null);
    return { ok: true, observation: observation.slice(0, 2000) };
  } catch (err) {
    return { ok: false, observation: `That tool failed: ${err instanceof Error ? err.message : "unknown error"}` };
  }
}

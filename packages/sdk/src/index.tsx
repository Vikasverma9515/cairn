"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { collectVisible } from "./context-collector";
import { logMiss } from "./element-ladder";
import { executeVerbResponse } from "./verb-executor";

export interface CopilotProps {
  /**
   * Reserved for a future client-side manifest fetch (e.g. inline citations
   * in the panel). Not required today — the server handler owns the
   * manifest and is the only thing that talks to the LLM.
   */
  manifest?: string;
  /** Where the widget posts questions. Defaults to "/api/copilot". */
  endpoint?: string;
  /** Action ids this deployment actually wired up for the "do" verb. */
  registeredActions?: string[];
  /** Called when the model returns a valid "do" verb for a registered action. */
  onDo?: (action: string) => void;
}

export function Copilot({ endpoint = "/api/copilot", registeredActions = [], onDo }: CopilotProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function ask(q: string) {
    setLoading(true);
    setAnswer(null);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: pathname, question: q, visible: collectVisible() }),
      });
      const data = await res.json().catch(() => null);
      executeVerbResponse(data, pathname, {
        onExplain: setAnswer,
        onNavigate: (route) => router.push(route),
        onMiss: logMiss,
        onDo,
        registeredActions,
      });
    } catch {
      setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <style>{COPILOT_STYLES}</style>
      <button className="cairn-fab" aria-label="Open Cairn help" onClick={() => setOpen((v) => !v)}>
        {open ? "×" : "?"}
      </button>
      {open && (
        <div className="cairn-panel" role="dialog" aria-label="Cairn help panel">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmed = question.trim();
              if (trimmed) void ask(trimmed);
            }}
          >
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What do you need help with?"
              aria-label="Ask Cairn a question"
              autoFocus
            />
          </form>
          {loading && <div className="cairn-answer cairn-loading">Thinking…</div>}
          {!loading && answer && <div className="cairn-answer">{answer}</div>}
        </div>
      )}
    </>
  );
}

const COPILOT_STYLES = `
@keyframes cairn-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.55); }
  50% { box-shadow: 0 0 0 8px rgba(99, 102, 241, 0); }
}
.cairn-glow {
  animation: cairn-pulse 0.9s ease-out 2;
  outline: 2px solid #6366f1;
  outline-offset: 2px;
  border-radius: 6px;
}
.cairn-fab {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483000;
  width: 52px;
  height: 52px;
  border-radius: 999px;
  border: none;
  background: #111827;
  color: white;
  font-size: 20px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.25);
}
.cairn-panel {
  position: fixed;
  right: 20px;
  bottom: 84px;
  z-index: 2147483000;
  width: 320px;
  max-height: 420px;
  overflow-y: auto;
  background: white;
  color: #111827;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25);
  padding: 16px;
  font: 14px/1.4 system-ui, -apple-system, sans-serif;
}
.cairn-panel input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font: inherit;
}
.cairn-answer {
  margin-top: 12px;
  white-space: pre-wrap;
}
.cairn-loading {
  color: #6b7280;
}
`;

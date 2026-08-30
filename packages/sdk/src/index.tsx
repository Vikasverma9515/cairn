"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { collectVisible } from "./context-collector";
import { logMiss, type MissContext } from "./element-ladder";
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
  onDo?: (action: string, target?: string) => void;
  /**
   * If set, a lookup miss is also POSTed here (in addition to the default
   * localStorage log) so failures can be aggregated server-side. Unset by
   * default — misses stay client-only unless you opt in.
   */
  reportMissesEndpoint?: string;
  /**
   * If set, shows a mic button that records a short clip and POSTs it here
   * for transcription (e.g. a route backed by Deepgram — see
   * `@cairn/sdk/server`'s `createTranscribeHandler`). Unset by default, and
   * hidden automatically if the browser has no microphone access.
   */
  transcribeEndpoint?: string;
}

export function Copilot({
  endpoint = "/api/copilot",
  registeredActions = [],
  onDo,
  reportMissesEndpoint,
  transcribeEndpoint,
}: CopilotProps) {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const micSupported =
    typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  function reportMiss(context: MissContext) {
    logMiss(context);
    if (reportMissesEndpoint) {
      fetch(reportMissesEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(context),
      }).catch(() => {
        // Best-effort — never let dashboard reporting break the widget.
      });
    }
  }

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
        onMiss: reportMiss,
        onDo,
        registeredActions,
      });
    } catch {
      setAnswer("Something went wrong reaching the help service — try again in a moment.");
    } finally {
      setLoading(false);
    }
  }

  async function startRecording() {
    if (!transcribeEndpoint || !micSupported) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        void transcribe(recorder.mimeType || "audio/webm");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setAnswer("Couldn't access the microphone — check your browser's permission for this site.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function transcribe(mimeType: string) {
    if (!transcribeEndpoint) return;
    setLoading(true);
    try {
      const blob = new Blob(audioChunksRef.current, { type: mimeType });
      const res = await fetch(transcribeEndpoint, {
        method: "POST",
        headers: { "content-type": mimeType },
        body: blob,
      });
      const data = await res.json().catch(() => null);
      if (data?.text) {
        setQuestion(data.text);
      } else {
        setAnswer("Couldn't make that out — try typing instead.");
      }
    } catch {
      setAnswer("Couldn't reach the transcription service.");
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
            <div className="cairn-input-row">
              <input
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                placeholder="What do you need help with?"
                aria-label="Ask Cairn a question"
                autoFocus
              />
              {transcribeEndpoint && micSupported && (
                <button
                  type="button"
                  className={recording ? "cairn-mic cairn-mic-active" : "cairn-mic"}
                  aria-label={recording ? "Stop recording" : "Ask by voice"}
                  onClick={() => (recording ? stopRecording() : void startRecording())}
                >
                  {recording ? "■" : "\u{1F3A4}"}
                </button>
              )}
            </div>
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
.cairn-input-row {
  display: flex;
  gap: 8px;
}
.cairn-input-row input {
  flex: 1;
}
.cairn-panel input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font: inherit;
}
.cairn-mic {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: white;
  cursor: pointer;
  font-size: 16px;
}
.cairn-mic-active {
  background: #fee2e2;
  border-color: #fca5a5;
}
.cairn-answer {
  margin-top: 12px;
  white-space: pre-wrap;
}
.cairn-loading {
  color: #6b7280;
}
`;

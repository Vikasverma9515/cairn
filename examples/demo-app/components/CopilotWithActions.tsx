"use client";

import { Copilot } from "@cairnvibe/sdk";

// Small client wrapper so app/layout.tsx (a server component, for metadata
// etc.) never has to pass a function prop across the server/client boundary.
export function CopilotWithActions() {
  async function handleDo(action: string, target?: string) {
    if (action === "archiveInvoice" && target) {
      // `target` is the manifest element id (e.g. "archive-inv-2") — this
      // fetch runs in the visitor's own browser session, illustrating
      // BUILD_PLAN's invariant #4: write actions run through the customer's
      // own auth, never a service key.
      const id = target.replace(/^archive-/, "");
      await fetch(`/api/invoices/${id}/archive`, { method: "POST" });
      window.location.reload();
    }
  }

  return (
    <Copilot
      registeredActions={["archiveInvoice"]}
      onDo={handleDo}
      reportMissesEndpoint="/api/copilot/misses"
      transcribeEndpoint="/api/copilot/transcribe"
      speakEndpoint="/api/copilot/speak"
      planEndpoint="/api/copilot/plan"
      criticEndpoint="/api/copilot/critic"
      realtimeUrl="ws://localhost:3010"
      persona="Cairn"
    />
  );
}

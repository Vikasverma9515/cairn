// Real, live-found gap this closes: /api/copilot's own route.ts used to
// call createCopilotHandler(...) fresh INSIDE every single POST handler —
// deliberate, for real manifest hot-reload (a `cairn build` while the dev
// server is running should take effect on the next question, no restart
// needed — see that route's own comment). But createCopilotHandler also
// builds a brand-new KeyRotator from scratch every time it's called, which
// meant a key confirmed dead via a real 401 (KeyRotator.markDead) got
// forgotten the instant that one request finished — the very next request
// rediscovered the SAME dead key was dead all over again, wasting a real
// API round trip on every single turn instead of just the first one.
//
// The fix: build the LLMs ONCE here, at module load — persisting for the
// life of this server process (this app's real "session"), same
// established pattern speak/route.ts's own handler already uses (built at
// module scope, not per-request, since it has no manifest dependency
// either). The route handlers below use the *WithLLM variants against
// these shared singletons instead of rebuilding an LLM (and therefore a
// fresh, dead-key-amnesiac KeyRotator) on every request. Manifest hot-
// reload is unaffected — that still happens per-request in each route's
// own loadManifest() call, a genuinely separate concern from which LLM
// object answers the question.
import { createCriticLLM, createPlanLLM, createVerbLLM, KeyRotator } from "@cairnvibe/sdk/server";

const provider = process.env.CAIRN_RUNTIME_PROVIDER === "anthropic" ? "anthropic" : "groq";
// The single source of truth for this deployment's registered actions —
// verbLLM's own tool schema (built from this) and /api/copilot/route.ts's
// resolveVerb-side allowlist (which checks a "do" verb's action id
// against this same list) must never drift apart, so both import it from
// here rather than each hard-coding their own copy.
export const registeredActions = ["archiveInvoice"];

// One shared rotator across all three LLM roles (verb, plan, critic) —
// see CreateCopilotHandlerOptions.keyRotator's own doc comment for the
// real gap this closes: without this, each createXLLM below built its
// OWN KeyRotator from the same GROQ_API_KEYS list, so a key one of them
// confirmed dead stayed invisible to the other two, which kept
// rediscovering it fresh on every call instead of learning it once.
const keyRotator = provider === "groq" ? KeyRotator.fromEnvList(process.env.GROQ_API_KEYS) ?? undefined : undefined;

export const verbLLM = createVerbLLM({ provider, registeredActions, keyRotator });
export const planLLM = createPlanLLM({ provider, keyRotator });
export const criticLLM = createCriticLLM({ provider, keyRotator });

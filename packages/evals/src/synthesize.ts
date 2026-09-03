// Turns a scenario's spoken goal into real audio bytes, once, cached to
// disk — this is what the fake-mic (fake-mic.ts) feeds into the browser's
// real getUserMedia so the realtime voice path runs against real synthesized
// speech instead of silence. Uses Deepgram's plain REST /v1/speak endpoint
// (not the streaming WS @cairnvibe/sdk uses for low-latency output) — a
// scenario's goal audio is generated once and cached, so REST's slower
// full-buffer response is fine here; this is test fixture generation, not
// a latency-sensitive runtime path.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEEPGRAM_SPEAK_URL = "https://api.deepgram.com/v1/speak";
const CACHE_DIR = path.join(process.cwd(), ".cache", "synthesized-audio");

export interface SynthesizeOptions {
  apiKey: string;
  model?: string;
}

/** Returns real MP3 bytes for `text`, from a local cache keyed by the text
 * + model (so editing a scenario's goal wording invalidates the cache
 * automatically instead of silently reusing stale audio). */
export async function synthesizeSpeech(text: string, options: SynthesizeOptions): Promise<Buffer> {
  const model = options.model ?? "aura-2-thalia-en";
  const cacheKey = crypto.createHash("sha256").update(`${model}::${text}`).digest("hex");
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.mp3`);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const response = await fetch(`${DEEPGRAM_SPEAK_URL}?model=${encodeURIComponent(model)}`, {
    method: "POST",
    headers: { Authorization: `Token ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`synthesizeSpeech: Deepgram returned ${response.status}: ${detail}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath, bytes);
  return bytes;
}

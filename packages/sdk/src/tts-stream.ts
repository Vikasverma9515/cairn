// Streaming Deepgram Aura TTS client — a persistent WebSocket against
// `wss://api.deepgram.com/v1/speak`, kept open for a whole realtime session
// instead of one REST POST per turn (that REST round trip is what made the
// old flow wait 5-10s for a whole MP3 to render and download before playing
// a single byte). Modeled directly on a verified working implementation
// (VOXERA's lib/deepgram/tts-stream.ts) — same protocol, same "one
// connection reused across turns" shape, adapted to take the API key as a
// constructor argument instead of reading it from process.env (Cairn's
// existing convention — see server.ts/realtime-server.ts, which are always
// handed a key rather than reading env vars themselves).
//
// Protocol (binary frames = raw audio; everything else is JSON control):
//   -> {"type":"Speak","text":"..."}   queue text for synthesis
//   -> {"type":"Flush"}                render audio for everything queued so far
//   -> {"type":"Clear"}                discard queued/in-flight audio
//   -> {"type":"Close"}                flush + gracefully end the connection
//   <- binary frames                   raw audio (encoding/sample_rate as configured)
//   <- {"type":"Flushed","sequence_id"} confirms a Flush's audio is fully sent
//   <- {"type":"Warning"/"Metadata"}    informational, non-fatal
import { WebSocket } from "ws";

const DEEPGRAM_SPEAK_WS_URL = "wss://api.deepgram.com/v1/speak";

export type SpeakChunkCallback = (audio: Buffer) => void;

export interface DeepgramSpeakStreamOptions {
  apiKey: string;
  model: string;
  /** "linear16" | "mulaw" | "alaw" */
  encoding: "linear16" | "mulaw" | "alaw";
  sampleRate: number;
}

export class DeepgramSpeakStream {
  private ws: WebSocket | null = null;
  private opts: DeepgramSpeakStreamOptions;
  private onAudioChunk: SpeakChunkCallback;
  private onFlushed?: (sequenceId: number) => void;
  private onError?: (err: Error) => void;
  private closed = false;

  constructor(
    opts: DeepgramSpeakStreamOptions,
    onAudioChunk: SpeakChunkCallback,
    handlers?: { onFlushed?: (sequenceId: number) => void; onError?: (err: Error) => void },
  ) {
    this.opts = opts;
    this.onAudioChunk = onAudioChunk;
    this.onFlushed = handlers?.onFlushed;
    this.onError = handlers?.onError;
  }

  /** Swaps which callback receives future audio frames without reopening the
   * socket — lets a caller keep ONE connection alive for a whole session
   * (avoiding a ~50-150ms handshake on every turn) while still rebinding a
   * fresh, turn-scoped handler each time. */
  public setAudioHandler(cb: SpeakChunkCallback): void {
    this.onAudioChunk = cb;
  }

  public async connect(): Promise<void> {
    const params = new URLSearchParams({
      model: this.opts.model,
      encoding: this.opts.encoding,
      sample_rate: String(this.opts.sampleRate),
      container: "none",
    });
    const url = `${DEEPGRAM_SPEAK_WS_URL}?${params.toString()}`;

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { Authorization: `Token ${this.opts.apiKey}` } });
      this.ws = socket;
      let settled = false;

      socket.once("open", () => {
        settled = true;
        resolve();
      });

      socket.on("message", (data: unknown, isBinary: boolean) => {
        if (isBinary) {
          this.onAudioChunk(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
          return;
        }
        try {
          const msg = JSON.parse(String(data));
          if (msg.type === "Flushed" && this.onFlushed) this.onFlushed(msg.sequence_id);
          else if (msg.type === "Warning") console.warn("[cairn realtime] Deepgram Speak warning:", msg.description);
        } catch {
          // ignore malformed control frames
        }
      });

      socket.once("error", (err: Error) => {
        console.error("[cairn realtime] Deepgram Speak stream error:", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.onError?.(err);
      });

      socket.on("close", () => {
        this.ws = null;
      });
    });
  }

  /** Queue text for synthesis — produces no audio until flush(). */
  public sendText(text: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "Speak", text }));
  }

  /** Render audio for everything queued so far. */
  public flush(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "Flush" }));
  }

  /** Discards queued/in-flight audio — for a future barge-in feature. */
  public clear(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "Clear" }));
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "Close" }));
      } catch {
        // socket may already be closing
      }
      this.ws.close();
    }
    this.ws = null;
  }
}

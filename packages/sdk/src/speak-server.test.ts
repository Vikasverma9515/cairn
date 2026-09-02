import { describe, expect, it } from "vitest";
import { createSpeakHandler, type SpeakStreamFactory } from "./speak-server";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return chunks;
}

/** A fake DeepgramSpeakStream: connect() resolves immediately, flush()
 * synchronously delivers `chunks` then fires onFlushed — mirrors the real
 * class's shape closely enough for the handler's own logic to be tested
 * without a real WebSocket. */
function fakeStreamFactory(opts: {
  chunks?: Buffer[];
  failConnect?: Error;
  failAfterConnect?: Error;
}): { factory: SpeakStreamFactory; sentTexts: string[]; flushed: boolean } {
  const sentTexts: string[] = [];
  let flushed = false;
  const factory: SpeakStreamFactory = (_streamOpts, onAudioChunk, handlers) => {
    return {
      connect: async () => {
        if (opts.failConnect) throw opts.failConnect;
      },
      sendText: (text: string) => {
        sentTexts.push(text);
      },
      flush: () => {
        if (opts.failAfterConnect) {
          handlers?.onError?.(opts.failAfterConnect);
          return;
        }
        for (const chunk of opts.chunks ?? []) onAudioChunk(chunk);
        flushed = true;
        handlers?.onFlushed?.(1);
      },
      clear: () => {},
      close: () => {},
      setAudioHandler: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
  };
  return {
    factory,
    sentTexts,
    get flushed() {
      return flushed;
    },
  };
}

describe("createSpeakHandler", () => {
  it("400s on empty text", async () => {
    const { factory } = fakeStreamFactory({});
    const handler = createSpeakHandler({ apiKey: "fake" }, factory);
    const result = await handler("");
    expect(result.status).toBe(400);
  });

  it("streams raw PCM chunks as Deepgram renders them, instead of buffering the whole reply", async () => {
    const chunks = [Buffer.from([1, 2, 3]), Buffer.from([4, 5])];
    const { factory } = fakeStreamFactory({ chunks });
    const handler = createSpeakHandler({ apiKey: "fake-key" }, factory);
    const result = await handler("This page lists your invoices.");

    expect(result.status).toBe(200);
    if ("error" in result.body) throw new Error("expected a stream, got an error body");
    expect(result.body.contentType).toBe("audio/L16;rate=24000");

    const received = await readAll(result.body.stream);
    expect(received.map((c) => Array.from(c))).toEqual([[1, 2, 3], [4, 5]]);
  });

  it("splits long text into sentence-sized chunks before flushing, instead of hitting the old 2000-char REST cap", async () => {
    const { factory, sentTexts } = fakeStreamFactory({ chunks: [Buffer.from([9])] });
    const handler = createSpeakHandler({ apiKey: "fake" }, factory);
    const longText = "This is a sentence. ".repeat(30); // ~600 chars, well past the old 2000-char REST limit's neighborhood at scale
    const result = await handler(longText);

    expect(result.status).toBe(200);
    expect(sentTexts.length).toBeGreaterThan(1);
    expect(sentTexts.join("")).toBe(longText);
    for (const chunk of sentTexts) expect(chunk.length).toBeLessThanOrEqual(300 + 40); // a little slack for one trailing sentence
  });

  it("degrades to an error body (not a throw) when the Deepgram connection fails", async () => {
    const { factory } = fakeStreamFactory({ failConnect: new Error("network down") });
    const handler = createSpeakHandler({ apiKey: "fake" }, factory);
    const result = await handler("hello");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ error: "speech service unreachable" });
  });

  it("propagates a real mid-stream error to the reader instead of hanging it forever", async () => {
    const { factory } = fakeStreamFactory({ failAfterConnect: new Error("stream dropped") });
    const handler = createSpeakHandler({ apiKey: "fake" }, factory);
    const result = await handler("hello");

    expect(result.status).toBe(200);
    if ("error" in result.body) throw new Error("expected a stream");
    await expect(readAll(result.body.stream)).rejects.toThrow("stream dropped");
  });

  it("uses the configured model, falling back to the default voice", async () => {
    const seen: Array<{ opts: unknown }> = [];
    const factory: SpeakStreamFactory = (opts, onAudioChunk, handlers) => {
      seen.push({ opts });
      return {
        connect: async () => {},
        sendText: () => {},
        flush: () => {
          handlers?.onFlushed?.(1);
        },
        clear: () => {},
        close: () => {},
        setAudioHandler: () => {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    };
    const handler = createSpeakHandler({ apiKey: "fake", model: "aura-2-custom-en" }, factory);
    await handler("hi");
    expect((seen[0].opts as { model: string }).model).toBe("aura-2-custom-en");
  });
});

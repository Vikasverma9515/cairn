import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpeakHandler } from "./speak-server";

describe("createSpeakHandler", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("400s on empty text", async () => {
    const handler = createSpeakHandler({ apiKey: "fake" });
    const result = await handler("");
    expect(result.status).toBe(400);
  });

  it("returns audio bytes on a successful Deepgram response", async () => {
    const fakeAudio = new Uint8Array([1, 2, 3]).buffer;
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "audio/mpeg" }),
      arrayBuffer: async () => fakeAudio,
    });
    vi.stubGlobal("fetch", fetchMock);

    const handler = createSpeakHandler({ apiKey: "fake-key" });
    const result = await handler("This page lists your invoices.");

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ audio: fakeAudio, contentType: "audio/mpeg" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/v1/speak");
    expect(init.headers.Authorization).toBe("Token fake-key");
    expect(JSON.parse(init.body)).toEqual({ text: "This page lists your invoices." });
  });

  it("degrades to an error body (not a throw) when Deepgram responds with an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" }),
    );
    const handler = createSpeakHandler({ apiKey: "fake" });
    const result = await handler("hello");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ error: "speech synthesis failed" });
  });

  it("degrades gracefully when the network call itself throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down")),
    );
    const handler = createSpeakHandler({ apiKey: "fake" });
    const result = await handler("hello");
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ error: "speech service unreachable" });
  });
});

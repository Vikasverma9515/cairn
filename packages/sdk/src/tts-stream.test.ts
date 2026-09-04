import { describe, expect, it } from "vitest";
import { splitFlushableSentences } from "./tts-stream";

describe("splitFlushableSentences", () => {
  it("returns nothing to flush when the buffer has no sentence-ending punctuation yet", () => {
    expect(splitFlushableSentences("The invoice for Acme")).toEqual({ toFlush: "", remainder: "The invoice for Acme" });
  });

  it("flushes a complete sentence followed by real whitespace", () => {
    expect(splitFlushableSentences("This is done. Now checking the next one")).toEqual({
      toFlush: "This is done.",
      remainder: "Now checking the next one",
    });
  });

  it("never flushes punctuation sitting at the current end of the buffer — more text (e.g. a decimal) might still be streaming in", () => {
    expect(splitFlushableSentences("The total is $3.")).toEqual({ toFlush: "", remainder: "The total is $3." });
  });

  it("correctly handles a real decimal number once the rest streams in — no false sentence break", () => {
    expect(splitFlushableSentences("The total is $3.50, thanks")).toEqual({ toFlush: "", remainder: "The total is $3.50, thanks" });
  });

  it("flushes up through the LAST complete sentence when the buffer contains several", () => {
    expect(splitFlushableSentences("First done. Second done. Still working on the third")).toEqual({
      toFlush: "First done. Second done.",
      remainder: "Still working on the third",
    });
  });

  it("handles ! and ? the same way as .", () => {
    expect(splitFlushableSentences("Done! What next? Still going")).toEqual({
      toFlush: "Done! What next?",
      remainder: "Still going",
    });
  });

  it("returns an empty remainder when the buffer ends exactly at a flushed boundary", () => {
    expect(splitFlushableSentences("All set. ")).toEqual({ toFlush: "All set.", remainder: "" });
  });

  it("is a pure, idempotent split — toFlush + remainder reconstructs everything meaningful, nothing dropped", () => {
    const buffer = "First part is ready. Second part is still streaming in";
    const { toFlush, remainder } = splitFlushableSentences(buffer);
    expect(`${toFlush} ${remainder}`.trim()).toBe(buffer);
  });
});

import { describe, expect, it } from "vitest";
import { classifyError } from "./ui";

describe("classifyError", () => {
  it("classifies a 429 status as a rate limit", () => {
    const err = Object.assign(new Error("Rate limit reached for model x"), { status: 429 });
    expect(classifyError(err).kind).toBe("rate_limit");
  });

  it("classifies a message mentioning rate limiting even without a status code", () => {
    // Real shape seen live: some SDK errors surface the provider's JSON body
    // as the message text rather than setting .status.
    const err = new Error('{"error":{"message":"Rate limit reached for model...","code":"rate_limit_exceeded"}}');
    expect(classifyError(err).kind).toBe("rate_limit");
  });

  it("classifies 401/403 as an auth problem", () => {
    expect(classifyError(Object.assign(new Error("bad"), { status: 401 })).kind).toBe("auth");
    expect(classifyError(Object.assign(new Error("bad"), { status: 403 })).kind).toBe("auth");
  });

  it("classifies an invalid-key message as auth even without a status code", () => {
    const err = new Error("Invalid API Key provided");
    expect(classifyError(err).kind).toBe("auth");
  });

  it("classifies 5xx as a network/server problem", () => {
    expect(classifyError(Object.assign(new Error("oops"), { status: 503 })).kind).toBe("network");
  });

  it("falls back to unknown for anything unrecognized, keeping the real message", () => {
    const err = new Error("something completely unexpected happened");
    const result = classifyError(err);
    expect(result.kind).toBe("unknown");
    expect(result.summary).toBe("something completely unexpected happened");
  });

  it("handles a thrown non-Error value without crashing", () => {
    expect(() => classifyError("just a string")).not.toThrow();
    expect(classifyError("just a string").kind).toBe("unknown");
  });
});

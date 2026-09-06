import { afterEach, describe, expect, it, vi } from "vitest";
import { KeyRotator } from "./key-rotator";

describe("KeyRotator", () => {
  it("throws if constructed with zero keys", () => {
    expect(() => new KeyRotator([])).toThrow();
  });

  it("round-robins across configured keys in order, wrapping around", () => {
    const rotator = new KeyRotator(["a", "b", "c"]);
    expect([rotator.take(), rotator.take(), rotator.take(), rotator.take()]).toEqual(["a", "b", "c", "a"]);
  });

  describe("fromEnvList", () => {
    it("returns null for an unset/empty value", () => {
      expect(KeyRotator.fromEnvList(undefined)).toBeNull();
      expect(KeyRotator.fromEnvList("")).toBeNull();
    });

    it("splits a comma-separated list, trimming whitespace and dropping empties", () => {
      const rotator = KeyRotator.fromEnvList(" a , b ,,c");
      expect(rotator?.size).toBe(3);
      expect([rotator!.take(), rotator!.take(), rotator!.take()]).toEqual(["a", "b", "c"]);
    });
  });

  describe("size / liveSize", () => {
    it("size is the full configured count regardless of dead keys", () => {
      const rotator = new KeyRotator(["a", "b", "c"]);
      rotator.markDead("a");
      expect(rotator.size).toBe(3);
    });

    it("liveSize shrinks as keys are marked dead", () => {
      const rotator = new KeyRotator(["a", "b", "c"]);
      expect(rotator.liveSize).toBe(3);
      rotator.markDead("a");
      expect(rotator.liveSize).toBe(2);
      rotator.markDead("b");
      expect(rotator.liveSize).toBe(1);
    });

    it("marking the same key dead twice doesn't double-count", () => {
      const rotator = new KeyRotator(["a", "b"]);
      rotator.markDead("a");
      rotator.markDead("a");
      expect(rotator.liveSize).toBe(1);
    });
  });

  describe("markDead — the real, live-found fix: a confirmed-invalid key stops being handed out", () => {
    afterEach(() => vi.restoreAllMocks());

    it("take() skips a key once it's been marked dead", () => {
      const rotator = new KeyRotator(["a", "b", "c"]);
      rotator.markDead("b");
      const seen = new Set<string>();
      for (let i = 0; i < 10; i++) seen.add(rotator.take());
      expect(seen.has("b")).toBe(false);
      expect(seen).toEqual(new Set(["a", "c"]));
    });

    it("still round-robins evenly across whatever keys remain live", () => {
      const rotator = new KeyRotator(["a", "b", "c"]);
      rotator.markDead("b");
      expect([rotator.take(), rotator.take(), rotator.take(), rotator.take()]).toEqual(["a", "c", "a", "c"]);
    });

    it("a key marked dead AFTER already being taken is excluded from every future take()", () => {
      const rotator = new KeyRotator(["a", "b"]);
      expect(rotator.take()).toBe("a"); // real, live use before it's known to be dead
      rotator.markDead("a");
      expect(rotator.take()).toBe("b");
      expect(rotator.take()).toBe("b");
    });

    it("real total-outage fallback: once EVERY key is marked dead, take() still returns something (the full original list) rather than breaking forever", () => {
      const rotator = new KeyRotator(["a", "b"]);
      rotator.markDead("a");
      rotator.markDead("b");
      expect(["a", "b"]).toContain(rotator.take());
      expect(["a", "b"]).toContain(rotator.take());
    });

    it("logs a real, once-per-key warning naming only the key's last 4 characters — never the full secret", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rotator = new KeyRotator(["gsk_realSecretValue1234"]);
      rotator.markDead("gsk_realSecretValue1234");
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = warn.mock.calls[0][0] as string;
      expect(logged).toContain("1234");
      expect(logged).not.toContain("gsk_realSecretValue1234");
    });

    it("marking the same key dead twice logs only once", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const rotator = new KeyRotator(["a", "b"]);
      rotator.markDead("a");
      rotator.markDead("a");
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

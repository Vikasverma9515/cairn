import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  CONVERSATION_STORAGE_KEY,
  loadPersistedConversation,
  savePersistedConversation,
  reconstructHistoryFromPersisted,
  type PersistedConversation,
} from "./index";

// This test file runs under vitest's default (node) environment — there is
// no jsdom here, so `window` isn't real. These three helpers are written to
// treat that exact case as "storage unavailable" (see loadPersistedConversation/
// savePersistedConversation's own `typeof window === "undefined"` guards), so
// a minimal fake `window.sessionStorage` (a real Storage-shaped object backed
// by a Map) is enough to exercise the real persistence logic without pulling
// in a full DOM.
function makeFakeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

describe("conversation persistence (sessionStorage-backed reload survival)", () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  beforeEach(() => {
    (globalThis as { window?: unknown }).window = { sessionStorage: makeFakeSessionStorage() };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
  });

  it("returns null when nothing has been saved yet", () => {
    expect(loadPersistedConversation()).toBeNull();
  });

  it("round-trips a real conversation through save then load", () => {
    const data: PersistedConversation = {
      transcript: [
        { id: 0, role: "user", text: "move this card to Done" },
        { id: 1, role: "agent", text: "Moved it." },
      ],
      lastQuestion: "what's next",
      answer: null,
      open: true,
    };
    savePersistedConversation(data);
    expect(loadPersistedConversation()).toEqual(data);
  });

  it("returns null (not a crash) when storage holds a corrupt value", () => {
    const win = (globalThis as unknown as { window: { sessionStorage: ReturnType<typeof makeFakeSessionStorage> } }).window;
    win.sessionStorage.setItem(CONVERSATION_STORAGE_KEY, "{not json");
    expect(loadPersistedConversation()).toBeNull();
  });

  it("drops malformed transcript entries instead of throwing", () => {
    const win = (globalThis as unknown as { window: { sessionStorage: ReturnType<typeof makeFakeSessionStorage> } }).window;
    win.sessionStorage.setItem(
      CONVERSATION_STORAGE_KEY,
      JSON.stringify({
        transcript: [
          { id: 0, role: "user", text: "valid" },
          { id: "not-a-number", role: "user", text: "bad id" },
          { role: "user", text: "missing id" },
          { id: 2, role: "narrator", text: "bad role" },
          "not even an object",
        ],
        lastQuestion: null,
        answer: null,
        open: false,
      }),
    );
    expect(loadPersistedConversation()?.transcript).toEqual([{ id: 0, role: "user", text: "valid" }]);
  });

  it("is a safe no-op (never throws) when window is undefined — the SSR/non-browser case", () => {
    (globalThis as { window?: unknown }).window = undefined;
    expect(() => savePersistedConversation({ transcript: [], lastQuestion: null, answer: null, open: false })).not.toThrow();
    expect(loadPersistedConversation()).toBeNull();
  });

  it("is a safe no-op (never throws) when storage.setItem itself throws — e.g. private-browsing quota", () => {
    (globalThis as { window?: unknown }).window = {
      sessionStorage: {
        getItem: () => {
          throw new Error("quota exceeded");
        },
        setItem: () => {
          throw new Error("quota exceeded");
        },
      },
    };
    expect(() => savePersistedConversation({ transcript: [], lastQuestion: null, answer: null, open: false })).not.toThrow();
    expect(loadPersistedConversation()).toBeNull();
  });
});

describe("reconstructHistoryFromPersisted (seeding historyRef from a restored conversation)", () => {
  it("returns an empty history when nothing was persisted", () => {
    expect(reconstructHistoryFromPersisted(null)).toEqual([]);
  });

  it("maps the archived transcript's roles onto HistoryEntry roles", () => {
    const persisted: PersistedConversation = {
      transcript: [
        { id: 0, role: "user", text: "hello" },
        { id: 1, role: "agent", text: "hi there" },
      ],
      lastQuestion: null,
      answer: null,
      open: false,
    };
    expect(reconstructHistoryFromPersisted(persisted)).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
    ]);
  });

  it("appends the live (not-yet-archived) question/answer after the archived transcript", () => {
    const persisted: PersistedConversation = {
      transcript: [{ id: 0, role: "user", text: "first turn" }],
      lastQuestion: "second turn",
      answer: "second answer",
      open: true,
    };
    expect(reconstructHistoryFromPersisted(persisted)).toEqual([
      { role: "user", text: "first turn" },
      { role: "user", text: "second turn" },
      { role: "assistant", text: "second answer" },
    ]);
  });

  it("omits a null lastQuestion/answer rather than inserting an empty turn", () => {
    const persisted: PersistedConversation = {
      transcript: [],
      lastQuestion: "only a question, no answer yet",
      answer: null,
      open: true,
    };
    expect(reconstructHistoryFromPersisted(persisted)).toEqual([{ role: "user", text: "only a question, no answer yet" }]);
  });

  it("caps the reconstructed history at MAX_HISTORY_TURNS, keeping the most recent turns", () => {
    const transcript = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      role: (i % 2 === 0 ? "user" : "agent") as "user" | "agent",
      text: `turn ${i}`,
    }));
    const persisted: PersistedConversation = { transcript, lastQuestion: null, answer: null, open: false };
    const result = reconstructHistoryFromPersisted(persisted);
    expect(result).toHaveLength(8);
    expect(result[0]).toEqual({ role: "user", text: "turn 4" });
    expect(result[7]).toEqual({ role: "assistant", text: "turn 11" });
  });
});

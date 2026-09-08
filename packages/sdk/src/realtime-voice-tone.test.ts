import { describe, expect, it } from "vitest";
import { VOICE_CONVERSATION_ADDENDUM } from "./realtime-server";

// The live model's actual output can't be unit-tested — these assert on
// the one thing that IS testable: that the prompt addendum actually
// carries the specific instructions this session's own voice-conversation
// spec asked for, at the content level. A live/eval-suite check is what
// verifies the model actually follows them; this is what verifies the
// instructions were never silently lost or worded wrong in the first
// place.
describe("VOICE_CONVERSATION_ADDENDUM", () => {
  it("bans the scripted/corporate openers explicitly named in the spec", () => {
    for (const phrase of ["Certainly", "Of course", "Absolutely", "Great question", "No problem", "I understand", "I'd be happy to assist", "Let me assist you"]) {
      expect(VOICE_CONVERSATION_ADDENDUM).toContain(phrase);
    }
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("never open a normal response with");
  });

  it("gives natural, short acknowledgment vocabulary and explicitly allows skipping one entirely", () => {
    for (const phrase of ["Yep.", "Got it.", "One sec.", "Found it.", "Done."]) {
      expect(VOICE_CONVERSATION_ADDENDUM).toContain(phrase);
    }
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("don't force one onto every reply");
  });

  it("bans narrating internal process, tools, or step-by-step mechanics", () => {
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain("never narrate your own internal process");
    expect(lower).toContain("step one complete, step two complete");
  });

  it("gives concrete word-count targets by response type", () => {
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("1-6 words");
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("5-15 words");
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("10-30 words");
  });

  it("instructs against over-confirming, and gives a natural clarification example", () => {
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain("don't over-confirm");
    expect(lower).toContain("would you like me to proceed");
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("Which one, Acme or Globex?");
  });

  it("covers honest uncertainty/failure handling, contrasting the plain phrasing against the apology-heavy phrasing it bans", () => {
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("I don't see an Acme invoice");
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("that didn't go through");
    // "I apologize" DOES appear — quoted as the banned example, the same
    // contrastive "never X, say Y instead" teaching style the rest of
    // this prompt uses throughout. The real assertion is that it's
    // introduced by "never," not offered as guidance to follow.
    expect(VOICE_CONVERSATION_ADDENDUM).toMatch(/never\s+"I apologize/);
  });

  it("requires result-aware phrasing grounded in the real outcome, not a generic template", () => {
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("Done, Acme's invoice is archived");
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("never a generic template");
  });

  it("bans markdown/structural formatting and internal ids/tool names from spoken output", () => {
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain("no markdown");
    expect(lower).toContain("no bullet points");
    expect(lower).toContain("no headings");
    expect(lower).toContain("no code blocks");
    expect(lower).toContain("no tables");
    expect(lower).toContain("never say an internal id, tool name");
  });

  it("specifies the real, Deepgram-documented three-dot pause convention, not a guessed one", () => {
    expect(VOICE_CONVERSATION_ADDENDUM).toContain('exactly three dots');
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("avoid all caps");
  });

  it("bans restating a target's name twice in one sentence, generalized to ANY target — a real, live-caught repetition bug that recurred once with a narrower fix", () => {
    // First live-caught instance: "The Edit button for the New task card
    // is the button labeled Edit on the New task card in the Todo
    // column." Fixed with a rule anchored to that one example. A second,
    // broader live batch caught the IDENTICAL failure shape recur for a
    // DIFFERENT target: "The Edit button for the CI card is the Edit
    // button in the In Progress column, right next to the CI card" — the
    // first fix was too narrowly worded to generalize past its own
    // example. Reworded here to lead with the general rule ("say a real
    // name once per sentence, not twice... no matter what the specific
    // target is named") and keep the concrete example as illustration of
    // the failure MODE, not the only case it applies to.
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain("say a real name once per sentence, not twice");
    expect(lower).toContain("no matter what the specific target is named");
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("CI card"); // the real, second live-caught example is present, not just the rule
  });

  it("requires tour steps to sound like a person pointing at their own screen, not documentation — a second real gap from the same live batch", () => {
    // Live-caught: "what can I do here" produced a real tour whose steps
    // read like a numbered help-doc ("Tap an Edit button on a card to
    // open its details in a modal. In the modal, update the title or
    // description in the text field. Press Save to apply changes or
    // Close to discard them.") — grammatically fine, but nothing a
    // person would actually say out loud mid-conversation. The shared
    // (non-voice-specific) prompt already says tour step text is spoken
    // aloud, but that alone wasn't enough to keep tour steps as casual
    // as a single-turn answer in practice.
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain('a "tour" verb\'s steps are read aloud one at a time');
    expect(lower).toContain("not a numbered instruction manual being read out loud");
    expect(lower).toContain("keep every step just as short as a single-turn answer would be");
  });

  it("bans 'Tap X to Y'/'Press X to Y' command-manual phrasing — the residual gap a retest found after the first tour fix only shortened steps without changing their style", () => {
    // Re-run after the first tour fix (above): steps got real-world
    // shorter and better-chunked ("Tap Add to create a new card in this
    // column." / "Press Save to apply the changes.") but every single
    // one still used imperative "Tap X to Y" / "Press X to Y" phrasing —
    // genuinely closer to a help doc's command list than to a person
    // describing their own screen, even at the right length. This rule
    // names that exact pattern directly rather than relying on "sound
    // natural" alone to shift it.
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain('"tap x to y" / "press x to y" / "click x to y"');
    expect(lower).toContain("describe what's there instead of instructing an action to take");
  });

  it("still requires a short spoken confirmation for highlight/open/navigate/do — preserved from the addendum this replaced", () => {
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("Highlighting the New Invoice button");
    expect(VOICE_CONVERSATION_ADDENDUM).toContain("Taking you to Invoices");
  });

  it("prohibits false human/memory claims", () => {
    const lower = VOICE_CONVERSATION_ADDENDUM.toLowerCase();
    expect(lower).toContain("never claim to be human");
    expect(lower).toContain("never invent an experience");
  });

  it("names the target persona explicitly, matching the spec's own framing", () => {
    expect(VOICE_CONVERSATION_ADDENDUM.toLowerCase()).toContain("extremely capable coworker");
  });
});

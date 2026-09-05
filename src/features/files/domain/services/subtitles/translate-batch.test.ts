import { describe, it, expect } from "vitest";
import {
  TRANSLATE_BATCH_CUES,
  TRANSLATE_CONTEXT_CUES,
  buildBatchPayload,
  buildTranslationSystemPrompt,
  flattenCueBreaks,
  parseTranslationReply,
  planTranslationBatches,
  unflattenCueBreaks,
} from "@files/domain/services/subtitles/translate-batch";

/**
 * The protocol for translating a track forty lines at a time.
 *
 * One failure mode dominates and drives every test here: a model that merges two subtitle lines
 * into one, or splits one into two, silently shifts every line after it onto the wrong timing.
 * A mistranslated word is a small local flaw; a line-count that does not match is the whole rest
 * of the film out of sync. So {@link parseTranslationReply} refuses anything it cannot match
 * one-to-one against the batch it answered, and refusing is what triggers the retry — never a
 * best-effort merge.
 *
 * The context lines exist for the opposite reason: a sentence that runs across a cue boundary is
 * unreadable when each half is translated blind. Neighbouring lines are sent to be *read* and
 * explicitly not to be translated, which is why the payload labels the two sections differently.
 */

const cue = (idx: number, text = `line ${idx}`) => ({
  idx,
  startMs: idx * 2_000,
  endMs: idx * 2_000 + 1_500,
  text,
});

const track = (count: number) => Array.from({ length: count }, (_, i) => cue(i));

describe("planTranslationBatches", () => {
  it("splits a track into full batches and a remainder", () => {
    const batches = planTranslationBatches(track(100), { size: 40 });
    expect(batches.map((batch) => batch.cues.length)).toEqual([40, 40, 20]);
  });

  it("covers every cue exactly once, in order", () => {
    const batches = planTranslationBatches(track(95), { size: 40 });
    const covered = batches.flatMap((batch) => batch.cues.map((c) => c.idx));
    expect(covered).toEqual(Array.from({ length: 95 }, (_, i) => i));
  });

  it("records where each batch starts, so progress can be reported", () => {
    const batches = planTranslationBatches(track(100), { size: 40 });
    expect(batches.map((batch) => batch.offset)).toEqual([0, 40, 80]);
  });

  it("gives the first batch no preceding context and the last none following", () => {
    const batches = planTranslationBatches(track(100), { size: 40 });
    expect(batches[0].before).toEqual([]);
    expect(batches[batches.length - 1].after).toEqual([]);
  });

  it("surrounds a middle batch with the lines either side of it", () => {
    const batches = planTranslationBatches(track(100), { size: 40, context: 3 });
    const middle = batches[1];
    expect(middle.cues[0].idx).toBe(40);
    expect(middle.before.map((c) => c.idx)).toEqual([37, 38, 39]);
    expect(middle.after.map((c) => c.idx)).toEqual([80, 81, 82]);
  });

  it("never repeats a batch's own line as its context", () => {
    for (const batch of planTranslationBatches(track(100), { size: 40, context: 3 })) {
      const own = new Set(batch.cues.map((c) => c.idx));
      for (const context of [...batch.before, ...batch.after]) {
        expect(own.has(context.idx)).toBe(false);
      }
    }
  });

  it("handles a track smaller than one batch", () => {
    const batches = planTranslationBatches(track(5), { size: 40 });
    expect(batches).toHaveLength(1);
    expect(batches[0].cues).toHaveLength(5);
    expect(batches[0].before).toEqual([]);
    expect(batches[0].after).toEqual([]);
  });

  it("plans nothing for an empty track", () => {
    expect(planTranslationBatches([], { size: 40 })).toEqual([]);
  });

  it("uses sane defaults when it is given none", () => {
    const batches = planTranslationBatches(track(TRANSLATE_BATCH_CUES + 1));
    expect(batches).toHaveLength(2);
    expect(batches[1].before).toHaveLength(TRANSLATE_CONTEXT_CUES);
  });
});

describe("buildBatchPayload", () => {
  const [first, second] = planTranslationBatches(track(100), { size: 40, context: 2 });

  it("numbers the lines to translate from one, whatever their place in the track", () => {
    const payload = buildBatchPayload(second);
    expect(payload).toContain("1. line 40");
    expect(payload).toContain("40. line 79");
  });

  it("marks the surrounding lines as context rather than work", () => {
    const payload = buildBatchPayload(second);
    expect(payload).toMatch(/do not translate/i);
    expect(payload).toContain("line 38");
    expect(payload).toContain("line 80");
  });

  it("leaves the context sections out entirely when there are none", () => {
    const payload = buildBatchPayload(first);
    expect(payload).not.toMatch(/^.*before.*$/im);
    expect(payload).toContain("1. line 0");
  });

  it("keeps a line break inside a cue, which is a change of speaker", () => {
    const [batch] = planTranslationBatches([cue(0, "- Who's there?\n- Me.")], { size: 40 });
    expect(buildBatchPayload(batch)).toContain("- Who's there? / - Me.");
  });

  it("says how many lines the reply must contain", () => {
    expect(buildBatchPayload(second)).toContain("40");
  });
});

describe("buildTranslationSystemPrompt", () => {
  it("names both directions", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "Japanese",
      targetLanguage: "Indonesian",
      glossary: [],
    });
    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("Indonesian");
  });

  it("pins the glossary the earlier pass decided", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "Japanese",
      targetLanguage: "Indonesian",
      glossary: [{ term: "鬼舞辻無惨", translation: "Muzan Kibutsuji" }],
    });
    expect(prompt).toContain("鬼舞辻無惨 → Muzan Kibutsuji");
  });

  it("omits the glossary section when there is nothing to pin", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: "Japanese",
      targetLanguage: "Indonesian",
      glossary: [],
    });
    expect(prompt).not.toMatch(/glossary/i);
  });

  it("states the rule that keeps timing intact", () => {
    const prompt = buildTranslationSystemPrompt({
      sourceLanguage: null,
      targetLanguage: "Indonesian",
      glossary: [],
    });
    expect(prompt).toMatch(/never merge|do not merge/i);
    expect(prompt).not.toContain("null");
  });
});

describe("parseTranslationReply", () => {
  it("reads a numbered reply", () => {
    expect(parseTranslationReply('[{"n":1,"text":"satu"},{"n":2,"text":"dua"}]', 2)).toEqual([
      "satu",
      "dua",
    ]);
  });

  it("puts a reply that came back out of order into the batch's order", () => {
    expect(parseTranslationReply('[{"n":2,"text":"dua"},{"n":1,"text":"satu"}]', 2)).toEqual([
      "satu",
      "dua",
    ]);
  });

  it("reads a reply wrapped in a markdown fence", () => {
    expect(parseTranslationReply('```json\n[{"n":1,"text":"satu"}]\n```', 1)).toEqual(["satu"]);
  });

  it("accepts a bare array of strings when its length is exactly right", () => {
    expect(parseTranslationReply('["satu","dua"]', 2)).toEqual(["satu", "dua"]);
  });

  it("keeps a line break the model returned inside one line", () => {
    expect(parseTranslationReply('[{"n":1,"text":"- Siapa?\\n- Aku."}]', 1)).toEqual([
      "- Siapa?\n- Aku.",
    ]);
  });

  it("refuses a reply with the wrong number of lines", () => {
    // The failure that would desynchronise everything after this batch.
    expect(parseTranslationReply('[{"n":1,"text":"satu"}]', 2)).toBeNull();
    expect(parseTranslationReply('[{"n":1,"text":"a"},{"n":2,"text":"b"},{"n":3,"text":"c"}]', 2)).toBeNull();
    expect(parseTranslationReply('["satu"]', 2)).toBeNull();
  });

  it("refuses a reply that skips a line or repeats one", () => {
    expect(parseTranslationReply('[{"n":1,"text":"a"},{"n":3,"text":"c"}]', 3)).toBeNull();
    expect(parseTranslationReply('[{"n":1,"text":"a"},{"n":1,"text":"a"}]', 2)).toBeNull();
  });

  it("refuses a line numbered outside the batch", () => {
    expect(parseTranslationReply('[{"n":0,"text":"a"},{"n":1,"text":"b"}]', 2)).toBeNull();
  });

  it("refuses a line that came back empty, rather than leaving a gap on screen", () => {
    expect(parseTranslationReply('[{"n":1,"text":"a"},{"n":2,"text":"   "}]', 2)).toBeNull();
  });

  it("refuses a reply that is not JSON at all", () => {
    expect(parseTranslationReply("I cannot translate this.", 2)).toBeNull();
    expect(parseTranslationReply("", 1)).toBeNull();
    expect(parseTranslationReply("null", 1)).toBeNull();
  });

  it("reads a numbered reply the model wrapped in an object", () => {
    expect(parseTranslationReply('{"lines":[{"n":1,"text":"satu"}]}', 1)).toEqual(["satu"]);
  });

  it("has nothing to do for an empty batch", () => {
    expect(parseTranslationReply("[]", 0)).toEqual([]);
  });
});

describe("cue break flattening", () => {
  it("shows a speaker change as a separator the model can carry through", () => {
    // The break itself is layout, but in two-speaker dialogue it is also meaning: without it
    // the model reads one utterance where there are two.
    expect(flattenCueBreaks("- Who's there?\n- Me.")).toBe("- Who's there? / - Me.");
  });

  it("leaves a single-line cue alone", () => {
    expect(flattenCueBreaks("Just one line")).toBe("Just one line");
  });

  it("turns the separator back into a break", () => {
    expect(unflattenCueBreaks("- Siapa? / - Aku.")).toBe("- Siapa?\n- Aku.");
  });

  it("leaves a translation that already came back with a real break alone", () => {
    expect(unflattenCueBreaks("- Siapa?\n- Aku.")).toBe("- Siapa?\n- Aku.");
  });

  it("survives a round trip", () => {
    expect(unflattenCueBreaks(flattenCueBreaks("- A\n- B"))).toBe("- A\n- B");
  });
});

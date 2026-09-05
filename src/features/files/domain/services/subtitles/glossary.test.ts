import { describe, it, expect } from "vitest";
import {
  buildGlossaryPrompt,
  buildGlossarySample,
  formatGlossary,
  parseGlossaryReply,
} from "@files/domain/services/subtitles/glossary";

/**
 * The glossary pass is what separates a translated transcript from a translated *film*.
 *
 * Translating forty lines at a time means each batch decides independently how to render a
 * character's name, a place, or a piece of invented terminology — so the same person ends up
 * spelled three ways across two hours, which is the single most obvious tell of machine
 * subtitles. One pass over a sample of the whole transcript settles those once, and every batch
 * afterwards is handed the answer.
 *
 * The sample has to span the whole film rather than its opening: names introduced in the third
 * act matter as much as the ones in the first, and a sample taken from the front would never see
 * them. That property is what most of these tests are about.
 */

const cue = (idx: number, text: string) => ({
  idx,
  startMs: idx * 2_000,
  endMs: idx * 2_000 + 1_500,
  text,
});

describe("buildGlossarySample", () => {
  it("uses the whole transcript when it already fits", () => {
    const cues = [cue(0, "First line"), cue(1, "Second line")];
    expect(buildGlossarySample(cues, 1_000)).toBe("First line\nSecond line");
  });

  it("stays inside the budget for a transcript that does not fit", () => {
    const cues = Array.from({ length: 500 }, (_, i) => cue(i, `Line number ${i} of the film`));
    expect(buildGlossarySample(cues, 600).length).toBeLessThanOrEqual(600);
  });

  it("samples across the whole film, not just the beginning", () => {
    const cues = Array.from({ length: 500 }, (_, i) => cue(i, `Line number ${i} of the film`));
    const sample = buildGlossarySample(cues, 600);
    // A name introduced late has to be able to reach the glossary.
    const sampled = [...sample.matchAll(/Line number (\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...sampled)).toBeLessThan(50);
    expect(Math.max(...sampled)).toBeGreaterThan(400);
  });

  it("returns the same sample every time it is asked", () => {
    const cues = Array.from({ length: 500 }, (_, i) => cue(i, `Line number ${i} of the film`));
    expect(buildGlossarySample(cues, 600)).toBe(buildGlossarySample(cues, 600));
  });

  it("keeps the sampled lines in the order they are spoken", () => {
    const cues = Array.from({ length: 300 }, (_, i) => cue(i, `Line number ${i}`));
    const sampled = [...buildGlossarySample(cues, 400).matchAll(/Line number (\d+)/g)].map((m) =>
      Number(m[1])
    );
    expect(sampled).toEqual([...sampled].sort((a, b) => a - b));
  });

  it("returns nothing for a transcript with no cues", () => {
    expect(buildGlossarySample([], 1_000)).toBe("");
  });

  it("does not choke on a single cue longer than the whole budget", () => {
    const sample = buildGlossarySample([cue(0, "x".repeat(5_000))], 100);
    expect(sample.length).toBeLessThanOrEqual(100);
    expect(sample.length).toBeGreaterThan(0);
  });
});

describe("buildGlossaryPrompt", () => {
  it("names both languages so the model knows which way round it is working", () => {
    const prompt = buildGlossaryPrompt({ sourceLanguage: "Japanese", targetLanguage: "Indonesian" });
    expect(prompt).toContain("Japanese");
    expect(prompt).toContain("Indonesian");
  });

  it("asks for JSON, since the reply is parsed rather than read", () => {
    expect(buildGlossaryPrompt({ sourceLanguage: "Japanese", targetLanguage: "Indonesian" })).toMatch(
      /JSON/
    );
  });

  it("copes with an unknown source language rather than saying 'null'", () => {
    const prompt = buildGlossaryPrompt({ sourceLanguage: null, targetLanguage: "Indonesian" });
    expect(prompt).not.toContain("null");
    expect(prompt).toContain("Indonesian");
  });
});

describe("parseGlossaryReply", () => {
  it("reads a plain JSON array", () => {
    expect(parseGlossaryReply('[{"term":"鬼舞辻無惨","translation":"Muzan Kibutsuji"}]')).toEqual([
      { term: "鬼舞辻無惨", translation: "Muzan Kibutsuji" },
    ]);
  });

  it("reads an array a model wrapped in a markdown fence", () => {
    const raw = '```json\n[{"term":"Tanjiro","translation":"Tanjiro"}]\n```';
    expect(parseGlossaryReply(raw)).toEqual([{ term: "Tanjiro", translation: "Tanjiro" }]);
  });

  it("reads an array a model buried in a sentence", () => {
    const raw = 'Here are the terms:\n[{"term":"Nezuko","translation":"Nezuko"}]\nHope that helps.';
    expect(parseGlossaryReply(raw)).toEqual([{ term: "Nezuko", translation: "Nezuko" }]);
  });

  it("accepts the object-with-a-key shape a model sometimes returns instead", () => {
    const raw = '{"glossary":[{"term":"Nezuko","translation":"Nezuko"}]}';
    expect(parseGlossaryReply(raw)).toEqual([{ term: "Nezuko", translation: "Nezuko" }]);
  });

  it("drops entries with nothing on one side of them", () => {
    const raw = '[{"term":"","translation":"x"},{"term":"y","translation":"  "},{"term":"a","translation":"b"}]';
    expect(parseGlossaryReply(raw)).toEqual([{ term: "a", translation: "b" }]);
  });

  it("keeps the first spelling when a term is listed twice", () => {
    const raw = '[{"term":"a","translation":"first"},{"term":"a","translation":"second"}]';
    expect(parseGlossaryReply(raw)).toEqual([{ term: "a", translation: "first" }]);
  });

  it("trims the whitespace a model leaves around its strings", () => {
    expect(parseGlossaryReply('[{"term":" a ","translation":" b "}]')).toEqual([
      { term: "a", translation: "b" },
    ]);
  });

  it("caps the list, because a glossary repeated into every batch costs tokens per batch", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ term: `t${i}`, translation: `x${i}` }));
    expect(parseGlossaryReply(JSON.stringify(many)).length).toBeLessThanOrEqual(120);
  });

  it("returns nothing rather than throwing when the reply is not usable", () => {
    expect(parseGlossaryReply("")).toEqual([]);
    expect(parseGlossaryReply("I could not find any terms.")).toEqual([]);
    expect(parseGlossaryReply("[")).toEqual([]);
    expect(parseGlossaryReply('["just a string"]')).toEqual([]);
    expect(parseGlossaryReply("null")).toEqual([]);
  });
});

describe("formatGlossary", () => {
  it("writes one pinned term per line", () => {
    expect(
      formatGlossary([
        { term: "鬼舞辻無惨", translation: "Muzan Kibutsuji" },
        { term: "日輪刀", translation: "Pedang Nichirin" },
      ])
    ).toBe("鬼舞辻無惨 → Muzan Kibutsuji\n日輪刀 → Pedang Nichirin");
  });

  it("is empty for an empty glossary, so the prompt can leave the section out", () => {
    expect(formatGlossary([])).toBe("");
  });
});

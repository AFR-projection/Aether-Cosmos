import { describe, it, expect } from "vitest";
import {
  MAX_CHARS_PER_LINE,
  MAX_CUE_MS,
  MIN_CUE_MS,
  MIN_GAP_MS,
  READING_CPS,
  activeCueIndex,
  mergeChunkTranscripts,
  normalizeCues,
  shiftCues,
  wrapCueText,
} from "@files/domain/services/subtitles/cues";

/**
 * The difference between subtitles that are technically present and subtitles that are
 * pleasant to watch is almost entirely in this file. Speech recognition hands back timings
 * that are accurate but not readable: a one-word answer gets a 300 ms cue that flashes past,
 * a stretch of silence gets a single 30-second cue, and the same sentence appears twice where
 * two audio chunks met. None of that is wrong about the audio; all of it is wrong on screen.
 *
 * One rule governs the whole module and is worth stating before the tests: **a cue's start is
 * never moved.** It is the one number that ties the text to the sound, so every adjustment
 * here is made by trimming or extending an end. A pass that shifted starts to make room would
 * fix a collision and desynchronise everything after it.
 */

const cue = (idx: number, startMs: number, endMs: number, text = "hello") => ({
  idx,
  startMs,
  endMs,
  text,
});

describe("normalizeCues", () => {
  it("leaves comfortable cues exactly as they are", () => {
    const input = [cue(0, 1_000, 3_000, "A comfortable line"), cue(1, 4_000, 6_000, "And another")];
    expect(normalizeCues(input)).toEqual(input);
  });

  it("puts cues in time order and renumbers them", () => {
    const out = normalizeCues([cue(0, 5_000, 6_000, "second"), cue(1, 1_000, 2_000, "first")]);
    expect(out.map((c) => c.text)).toEqual(["first", "second"]);
    expect(out.map((c) => c.idx)).toEqual([0, 1]);
  });

  it("holds a cue on screen long enough to read rather than flashing it", () => {
    const [only] = normalizeCues([cue(0, 1_000, 1_150, "Yes")]);
    expect(only.endMs - only.startMs).toBeGreaterThanOrEqual(MIN_CUE_MS);
    expect(only.startMs).toBe(1_000);
  });

  it("gives a long line the time its length actually needs", () => {
    const text = "x".repeat(READING_CPS * 4);
    const [only] = normalizeCues([cue(0, 0, 500, text)]);
    expect(only.endMs).toBeGreaterThanOrEqual(3_500);
  });

  it("never lets one cue linger over the silence after it", () => {
    const [only] = normalizeCues([cue(0, 0, 40_000, "brief")]);
    expect(only.endMs - only.startMs).toBe(MAX_CUE_MS);
  });

  it("trims the earlier cue instead of pushing the later one late", () => {
    const out = normalizeCues([cue(0, 1_000, 5_000, "first"), cue(1, 2_000, 4_000, "second")]);
    expect(out[1].startMs).toBe(2_000);
    expect(out[0].endMs).toBeLessThanOrEqual(2_000 - MIN_GAP_MS);
  });

  it("repairs a cue whose end precedes its start", () => {
    const [only] = normalizeCues([cue(0, 5_000, 1_000, "backwards")]);
    expect(only.endMs).toBeGreaterThan(only.startMs);
  });

  it("pulls a negative start back to the beginning of the clip", () => {
    const [only] = normalizeCues([cue(0, -500, 2_000, "early")]);
    expect(only.startMs).toBe(0);
  });

  it("drops a cue with nothing to show", () => {
    expect(normalizeCues([cue(0, 0, 1_000, "   "), cue(1, 2_000, 3_000, "real")])).toHaveLength(1);
  });

  it("trims surrounding whitespace off the text it keeps", () => {
    expect(normalizeCues([cue(0, 0, 2_000, "  padded  ")])[0].text).toBe("padded");
  });

  it("survives times that are not numbers at all", () => {
    const out = normalizeCues([
      { idx: 0, startMs: Number.NaN, endMs: Number.POSITIVE_INFINITY, text: "odd" },
    ]);
    expect(Number.isFinite(out[0].startMs)).toBe(true);
    expect(Number.isFinite(out[0].endMs)).toBe(true);
    expect(out[0].endMs).toBeGreaterThan(out[0].startMs);
  });

  it("returns nothing for nothing", () => {
    expect(normalizeCues([])).toEqual([]);
  });
});

describe("mergeChunkTranscripts", () => {
  it("shifts each chunk's cues by where that chunk started", () => {
    const out = mergeChunkTranscripts([
      { offsetMs: 0, cues: [cue(0, 1_000, 2_000, "first")] },
      { offsetMs: 600_000, cues: [cue(0, 500, 1_500, "second")] },
    ]);
    expect(out).toEqual([
      { idx: 0, startMs: 1_000, endMs: 2_000, text: "first" },
      { idx: 1, startMs: 600_500, endMs: 601_500, text: "second" },
    ]);
  });

  it("drops the line a chunk repeats from the one before it", () => {
    // The carry-over prompt tells the next chunk what was just said, and Whisper sometimes
    // opens by saying it again. Two identical lines across a boundary are that, not dialogue.
    const out = mergeChunkTranscripts([
      { offsetMs: 0, cues: [cue(0, 9_000, 10_000, "See you tomorrow.")] },
      { offsetMs: 10_000, cues: [cue(0, 0, 900, "See you tomorrow."), cue(1, 1_000, 2_000, "Wait.")] },
    ]);
    expect(out.map((c) => c.text)).toEqual(["See you tomorrow.", "Wait."]);
  });

  it("collapses a line Whisper repeats over silence into one cue", () => {
    const out = mergeChunkTranscripts([
      {
        offsetMs: 0,
        cues: [
          cue(0, 0, 2_000, "Thank you."),
          cue(1, 2_000, 4_000, "Thank you."),
          cue(2, 4_000, 6_000, "Thank you."),
        ],
      },
    ]);
    expect(out).toEqual([{ idx: 0, startMs: 0, endMs: 6_000, text: "Thank you." }]);
  });

  it("keeps a genuine repetition that is separated by other dialogue", () => {
    const out = mergeChunkTranscripts([
      {
        offsetMs: 0,
        cues: [cue(0, 0, 1_000, "No."), cue(1, 2_000, 3_000, "Why?"), cue(2, 4_000, 5_000, "No.")],
      },
    ]);
    expect(out).toHaveLength(3);
  });

  it("keeps a line repeated after a long pause, which is dialogue rather than a stutter", () => {
    const out = mergeChunkTranscripts([
      { offsetMs: 0, cues: [cue(0, 0, 1_000, "Hello?"), cue(1, 30_000, 31_000, "Hello?")] },
    ]);
    expect(out).toHaveLength(2);
  });

  it("skips a chunk that produced nothing", () => {
    const out = mergeChunkTranscripts([
      { offsetMs: 0, cues: [] },
      { offsetMs: 600_000, cues: [cue(0, 0, 1_000, "only")] },
    ]);
    expect(out).toEqual([{ idx: 0, startMs: 600_000, endMs: 601_000, text: "only" }]);
  });
});

describe("wrapCueText", () => {
  it("leaves a line that already fits alone", () => {
    expect(wrapCueText("Short enough")).toBe("Short enough");
  });

  it("breaks a long line at a word boundary", () => {
    const wrapped = wrapCueText(
      "This sentence is considerably longer than a single subtitle line should ever be"
    );
    const lines = wrapped.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_CHARS_PER_LINE);
    expect(wrapped.replace(/\n/g, " ")).toBe(
      "This sentence is considerably longer than a single subtitle line should ever be"
    );
  });

  it("breaks scripts that do not use spaces by character instead of giving up", () => {
    const japanese = "あ".repeat(60);
    const lines = wrapCueText(japanese).split("\n");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(MAX_CHARS_PER_LINE);
    expect(lines.join("")).toBe(japanese);
  });

  it("keeps a break the writer put there", () => {
    expect(wrapCueText("- Who's there?\n- Me.")).toBe("- Who's there?\n- Me.");
  });

  it("never drops a word that is longer than a whole line", () => {
    const wrapped = wrapCueText(`short ${"z".repeat(MAX_CHARS_PER_LINE + 10)}`);
    expect(wrapped).toContain("z".repeat(MAX_CHARS_PER_LINE + 10));
  });
});

describe("activeCueIndex", () => {
  const cues = [cue(0, 1_000, 2_000, "a"), cue(1, 3_000, 4_000, "b"), cue(2, 5_000, 6_000, "c")];

  it("finds the cue covering the playhead", () => {
    expect(activeCueIndex(cues, 3_500)).toBe(1);
  });

  it("includes the cue's own start and excludes its end", () => {
    expect(activeCueIndex(cues, 3_000)).toBe(1);
    expect(activeCueIndex(cues, 4_000)).toBe(-1);
  });

  it("reports nothing in the gaps and outside the track", () => {
    expect(activeCueIndex(cues, 0)).toBe(-1);
    expect(activeCueIndex(cues, 2_500)).toBe(-1);
    expect(activeCueIndex(cues, 99_000)).toBe(-1);
    expect(activeCueIndex([], 1_000)).toBe(-1);
  });
});

describe("shiftCues", () => {
  it("moves every cue by the same amount", () => {
    const out = shiftCues([cue(0, 1_000, 2_000), cue(1, 3_000, 4_000)], 500);
    expect(out.map((c) => c.startMs)).toEqual([1_500, 3_500]);
    expect(out.map((c) => c.endMs)).toEqual([2_500, 4_500]);
  });

  it("keeps a cue dragged before the start of the clip inside it, without inverting it", () => {
    const [only] = shiftCues([cue(0, 200, 1_200)], -1_000);
    expect(only.startMs).toBe(0);
    expect(only.endMs).toBeGreaterThan(0);
  });

  it("does not mutate what it was given", () => {
    const input = [cue(0, 1_000, 2_000)];
    shiftCues(input, 1_000);
    expect(input[0].startMs).toBe(1_000);
  });
});

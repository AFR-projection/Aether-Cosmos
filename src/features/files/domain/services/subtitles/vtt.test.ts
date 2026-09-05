import { describe, it, expect } from "vitest";
import {
  cuesToVtt,
  formatVttTimestamp,
  parseSrt,
  parseSubtitleFile,
  parseTimestamp,
  parseVtt,
} from "@files/domain/services/subtitles/vtt";

/**
 * Timed text is the one place in this feature where a single character decides whether a
 * two-hour film is watchable: a comma read as a full stop moves a line by a second, and a
 * `-->` that survives into cue text ends the cue early. So the parsers are pinned against
 * the shapes real subtitle files actually arrive in — files written by hand, by Windows
 * tools that use CRLF, by editors that leave a BOM, and by exporters that number cues from
 * one and sometimes not at all.
 *
 * The round-trip test is the load-bearing one: everything this app serves to a `<track>`
 * element goes out through `cuesToVtt`, and everything a user attaches comes in through
 * `parseSubtitleFile`. If those two disagree, a file exported from here cannot be
 * re-imported here.
 */

describe("formatVttTimestamp", () => {
  it("writes the hours field WebVTT parsers expect", () => {
    expect(formatVttTimestamp(0)).toBe("00:00:00.000");
    expect(formatVttTimestamp(83_456)).toBe("00:01:23.456");
    expect(formatVttTimestamp(3_723_004)).toBe("01:02:03.004");
  });

  it("keeps counting past a day rather than wrapping to zero", () => {
    expect(formatVttTimestamp(90_000_000)).toBe("25:00:00.000");
  });

  it("floors a negative or unusable value to the start of the clip", () => {
    expect(formatVttTimestamp(-1)).toBe("00:00:00.000");
    expect(formatVttTimestamp(Number.NaN)).toBe("00:00:00.000");
    expect(formatVttTimestamp(Number.POSITIVE_INFINITY)).toBe("00:00:00.000");
  });
});

describe("parseTimestamp", () => {
  it("reads the WebVTT form", () => {
    expect(parseTimestamp("00:01:23.456")).toBe(83_456);
  });

  it("reads SRT's comma as the same decimal separator", () => {
    expect(parseTimestamp("00:01:23,456")).toBe(83_456);
  });

  it("reads the two-field form WebVTT also allows", () => {
    expect(parseTimestamp("01:23.456")).toBe(83_456);
  });

  it("tolerates a short or missing fraction", () => {
    expect(parseTimestamp("00:00:01.5")).toBe(1_500);
    expect(parseTimestamp("00:00:01")).toBe(1_000);
  });

  it("refuses anything that is not a timestamp", () => {
    expect(parseTimestamp("")).toBeNull();
    expect(parseTimestamp("later")).toBeNull();
    expect(parseTimestamp("1:2:3:4")).toBeNull();
  });
});

describe("parseVtt", () => {
  it("reads a plain file", () => {
    const cues = parseVtt(
      ["WEBVTT", "", "00:00:01.000 --> 00:00:03.000", "Hello", "", "00:00:04.000 --> 00:00:06.000", "World"].join("\n")
    );
    expect(cues).toEqual([
      { idx: 0, startMs: 1_000, endMs: 3_000, text: "Hello" },
      { idx: 1, startMs: 4_000, endMs: 6_000, text: "World" },
    ]);
  });

  it("joins a cue that spans two lines", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nfirst\nsecond");
    expect(cues[0].text).toBe("first\nsecond");
  });

  it("ignores cue settings after the end timestamp", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000 line:90% align:center\nHi");
    expect(cues[0]).toMatchObject({ startMs: 1_000, endMs: 3_000, text: "Hi" });
  });

  it("skips a cue identifier line", () => {
    const cues = parseVtt("WEBVTT\n\nintro\n00:00:01.000 --> 00:00:03.000\nHi");
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("Hi");
  });

  it("drops NOTE and STYLE blocks instead of reading them as dialogue", () => {
    const cues = parseVtt(
      [
        "WEBVTT",
        "",
        "NOTE this file was machine generated",
        "",
        "STYLE",
        "::cue { color: yellow }",
        "",
        "00:00:01.000 --> 00:00:03.000",
        "Hi",
      ].join("\n")
    );
    expect(cues).toEqual([{ idx: 0, startMs: 1_000, endMs: 3_000, text: "Hi" }]);
  });

  it("unescapes the entities WebVTT requires in cue text", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n&lt;3 Bread &amp; butter");
    expect(cues[0].text).toBe("<3 Bread & butter");
  });

  it("reads a file that arrives with a BOM and CRLF line endings", () => {
    const cues = parseVtt("﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nHi\r\n");
    expect(cues).toEqual([{ idx: 0, startMs: 1_000, endMs: 3_000, text: "Hi" }]);
  });

  it("drops a cue whose text is empty, since it would show as a blank flash", () => {
    const cues = parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n\n00:00:04.000 --> 00:00:05.000\nHi");
    expect(cues).toEqual([{ idx: 0, startMs: 4_000, endMs: 5_000, text: "Hi" }]);
  });

  it("returns nothing for a file with no cues at all", () => {
    expect(parseVtt("WEBVTT\n\n")).toEqual([]);
    expect(parseVtt("")).toEqual([]);
  });
});

describe("parseSrt", () => {
  it("reads a numbered file with comma decimals", () => {
    const cues = parseSrt(
      ["1", "00:00:01,000 --> 00:00:03,000", "Hello", "", "2", "00:00:04,000 --> 00:00:06,000", "World"].join("\n")
    );
    expect(cues).toEqual([
      { idx: 0, startMs: 1_000, endMs: 3_000, text: "Hello" },
      { idx: 1, startMs: 4_000, endMs: 6_000, text: "World" },
    ]);
  });

  it("keeps the second line of a two-line subtitle", () => {
    const cues = parseSrt("1\n00:00:01,000 --> 00:00:03,000\n- Who's there?\n- Me.");
    expect(cues[0].text).toBe("- Who's there?\n- Me.");
  });

  it("reads a file whose cues carry no sequence number", () => {
    const cues = parseSrt("00:00:01,000 --> 00:00:03,000\nHi");
    expect(cues).toEqual([{ idx: 0, startMs: 1_000, endMs: 3_000, text: "Hi" }]);
  });

  it("renumbers from zero rather than trusting the file's own sequence", () => {
    const cues = parseSrt("7\n00:00:01,000 --> 00:00:02,000\nA\n\n9\n00:00:03,000 --> 00:00:04,000\nB");
    expect(cues.map((cue) => cue.idx)).toEqual([0, 1]);
  });
});

describe("parseSubtitleFile", () => {
  it("recognises WebVTT by its header", () => {
    const cues = parseSubtitleFile("WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHi");
    expect(cues).toHaveLength(1);
  });

  it("falls back to SRT when there is no header", () => {
    const cues = parseSubtitleFile("1\n00:00:01,000 --> 00:00:03,000\nHi");
    expect(cues).toHaveLength(1);
  });

  it("still reads a headerless file that uses full-stop decimals", () => {
    const cues = parseSubtitleFile("1\n00:00:01.000 --> 00:00:03.000\nHi");
    expect(cues).toEqual([{ idx: 0, startMs: 1_000, endMs: 3_000, text: "Hi" }]);
  });
});

describe("cuesToVtt", () => {
  it("writes the header a `<track>` element requires", () => {
    expect(cuesToVtt([])).toBe("WEBVTT\n");
  });

  it("writes one block per cue", () => {
    const vtt = cuesToVtt([
      { idx: 0, startMs: 1_000, endMs: 3_000, text: "Hello" },
      { idx: 1, startMs: 4_000, endMs: 6_000, text: "World" },
    ]);
    expect(vtt).toBe(
      [
        "WEBVTT",
        "",
        "1",
        "00:00:01.000 --> 00:00:03.000",
        "Hello",
        "",
        "2",
        "00:00:04.000 --> 00:00:06.000",
        "World",
        "",
      ].join("\n")
    );
  });

  it("escapes the characters a WebVTT parser would read as markup", () => {
    const vtt = cuesToVtt([{ idx: 0, startMs: 0, endMs: 1_000, text: "<3 Bread & butter" }]);
    expect(vtt).toContain("&lt;3 Bread &amp; butter");
  });

  it("never lets an arrow or a blank line inside cue text end the cue early", () => {
    const vtt = cuesToVtt([{ idx: 0, startMs: 0, endMs: 1_000, text: "a --> b\n\nstill the same cue" }]);
    // `>` is always escaped, so a literal `-->` cannot appear on a cue text line and be
    // mistaken for the next cue's timing — and it unescapes back to exactly what was written.
    expect(vtt).not.toContain("a --> b");
    expect(vtt).toContain("a --&gt; b");
    const parsed = parseVtt(vtt);
    expect(parsed).toHaveLength(1);
    // The blank line IS lost: it terminates a cue in both formats, so there is nowhere for
    // it to go. Collapsing it keeps the cue whole, which is the part that matters.
    expect(parsed[0].text).toBe("a --> b\nstill the same cue");
  });

  it("survives a round trip", () => {
    const cues = [
      { idx: 0, startMs: 1_500, endMs: 3_250, text: "First line\nsecond line" },
      { idx: 1, startMs: 3_250, endMs: 90_000_000, text: "Bread & butter" },
    ];
    expect(parseSubtitleFile(cuesToVtt(cues))).toEqual(cues);
  });
});

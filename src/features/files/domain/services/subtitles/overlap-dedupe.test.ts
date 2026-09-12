import { describe, expect, it } from "vitest";
import {
  dedupeOverlappingCueBoundary,
  stitchOverlappingCuePartitions,
} from "@files/domain/services/subtitles/overlap-dedupe";

const cue = (idx: number, startMs: number, endMs: number, text: string) => ({
  idx,
  startMs,
  endMs,
  text,
});

describe("dedupeOverlappingCueBoundary", () => {
  it("removes the longest repeated suffix/prefix", () => {
    const previous = [
      cue(10, 598_000, 599_000, "One"),
      cue(11, 599_000, 601_000, "Boundary line"),
    ];
    const incoming = [
      cue(0, 599_100, 601_100, "  boundary   line "),
      cue(1, 601_200, 602_000, "New line"),
    ];
    expect(dedupeOverlappingCueBoundary(previous, incoming).map((item) => item.text)).toEqual([
      "New line",
    ]);
  });

  it("removes multiple carry-over lines but not a later genuine repetition", () => {
    const previous = [cue(0, 8_000, 9_000, "A"), cue(1, 9_000, 10_000, "B")];
    const incoming = [
      cue(0, 8_100, 9_100, "A"),
      cue(1, 9_100, 10_100, "B"),
      cue(2, 20_000, 21_000, "A"),
    ];
    expect(dedupeOverlappingCueBoundary(previous, incoming).map((item) => item.text)).toEqual(["A"]);
  });

  it("does not dedupe matching text far outside the overlap", () => {
    const previous = [cue(0, 0, 1_000, "Again")];
    const incoming = [cue(0, 20_000, 21_000, "Again")];
    expect(dedupeOverlappingCueBoundary(previous, incoming)).toEqual(incoming);
  });

  it("does not mutate either checkpoint", () => {
    const previous = [cue(7, 0, 1_000, "A")];
    const incoming = [cue(8, 0, 1_000, "A"), cue(9, 1_000, 2_000, "B")];
    dedupeOverlappingCueBoundary(previous, incoming);
    expect(previous[0].idx).toBe(7);
    expect(incoming[0].idx).toBe(8);
  });
});

describe("stitchOverlappingCuePartitions", () => {
  it("materializes the prior tail and unique incoming cues exactly once", () => {
    const stitched = stitchOverlappingCuePartitions(
      [cue(99, 9_000, 10_000, "boundary")],
      [cue(100, 9_100, 10_100, "Boundary"), cue(101, 10_200, 11_000, "next")]
    );
    expect(stitched.map((item) => item.text)).toEqual(["boundary", "next"]);
    expect(stitched.map((item) => item.idx)).toEqual([0, 1]);
  });
});

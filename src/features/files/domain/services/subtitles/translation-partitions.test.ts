import { describe, expect, it } from "vitest";
import {
  TRANSLATION_PARTITION_MAX_BYTES,
  TRANSLATION_PARTITION_MAX_CHARACTERS,
  TRANSLATION_PARTITION_MAX_CUES,
  bisectTranslationPartition,
  planTranslationPartitions,
} from "@files/domain/services/subtitles/translation-partitions";

const cue = (idx: number, text = `cue ${idx}`) => ({
  idx,
  startMs: idx * 1_000,
  endMs: idx * 1_000 + 900,
  text,
});

describe("planTranslationPartitions", () => {
  it("covers more than twenty thousand virtual cues exactly once", () => {
    const cues = Array.from({ length: 20_123 }, (_, index) => cue(index));
    const partitions = planTranslationPartitions(cues);
    expect(partitions.length).toBeGreaterThan(1);
    expect(partitions.flatMap((partition) => partition.cues.map((item) => item.idx))).toEqual(
      cues.map((item) => item.idx)
    );
    expect(partitions.every((partition) => partition.cues.length <= TRANSLATION_PARTITION_MAX_CUES)).toBe(
      true
    );
  });

  it("enforces all combined request bounds", () => {
    const cues = Array.from({ length: 400 }, (_, index) => cue(index, "界".repeat(1_000)));
    for (const partition of planTranslationPartitions(cues)) {
      expect(partition.cues.length).toBeLessThanOrEqual(TRANSLATION_PARTITION_MAX_CUES);
      expect(partition.characterCount).toBeLessThanOrEqual(TRANSLATION_PARTITION_MAX_CHARACTERS);
      expect(partition.serializedBytes).toBeLessThanOrEqual(TRANSLATION_PARTITION_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(partition.cues), "utf8")).toBe(partition.serializedBytes);
    }
  });

  it("keeps large starting ordinals and offsets", () => {
    const partitions = planTranslationPartitions([cue(20_001), cue(20_002)], {
      maxCues: 1,
      startingOrdinal: 12_345,
      startingOffset: 20_001,
    });
    expect(partitions.map((partition) => [partition.ordinal, partition.offset])).toEqual([
      [12_345, 20_001],
      [12_346, 20_002],
    ]);
  });

  it("rejects a single unpartitionable cue instead of truncating it", () => {
    const text = "x".repeat(TRANSLATION_PARTITION_MAX_CHARACTERS + 1);
    expect(() => planTranslationPartitions([cue(7, text)])).toThrow(/Cue 7/);
  });

  it("plans nothing for no cues", () => {
    expect(planTranslationPartitions([])).toEqual([]);
  });
});

describe("bisectTranslationPartition", () => {
  it("splits malformed batches deterministically without losing order", () => {
    const [partition] = planTranslationPartitions(Array.from({ length: 9 }, (_, index) => cue(index)));
    const split = bisectTranslationPartition(partition);
    expect(split?.map((child) => child.cues.length)).toEqual([4, 5]);
    expect(split?.flatMap((child) => child.cues.map((item) => item.idx))).toEqual(
      partition.cues.map((item) => item.idx)
    );
    expect(bisectTranslationPartition(partition)).toEqual(split);
  });

  it("stops at one cue", () => {
    const [partition] = planTranslationPartitions([cue(0)]);
    expect(bisectTranslationPartition(partition)).toBeNull();
  });
});

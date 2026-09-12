import { describe, expect, it } from "vitest";
import {
  SUBTITLE_CHUNK_DURATION_MS,
  SUBTITLE_CHUNK_OVERLAP_MS,
  SUBTITLE_PLAN_AHEAD_CHUNKS,
  automaticSubtitlePipelineKey,
  planSubtitleChunks,
  subtitleCheckpointKey,
  subtitleProviderRequestKey,
} from "@files/domain/services/subtitles/pipeline-planning";

describe("planSubtitleChunks", () => {
  it("plans at most 24 ten-minute chunks with overlap", () => {
    const plan = planSubtitleChunks({ durationMs: 30 * SUBTITLE_CHUNK_DURATION_MS });
    expect(plan.chunks).toHaveLength(SUBTITLE_PLAN_AHEAD_CHUNKS);
    expect(plan.chunks[0]).toMatchObject({
      ordinal: 0,
      startMs: 0,
      coreStartMs: 0,
      endMs: SUBTITLE_CHUNK_DURATION_MS,
      overlapBeforeMs: 0,
    });
    expect(plan.chunks[1]).toMatchObject({
      startMs: SUBTITLE_CHUNK_DURATION_MS - SUBTITLE_CHUNK_OVERLAP_MS,
      coreStartMs: SUBTITLE_CHUNK_DURATION_MS,
      endMs: 2 * SUBTITLE_CHUNK_DURATION_MS - SUBTITLE_CHUNK_OVERLAP_MS,
      overlapBeforeMs: SUBTITLE_CHUNK_OVERLAP_MS,
    });
    expect(plan.chunks.every((chunk) => chunk.endMs - chunk.startMs <= SUBTITLE_CHUNK_DURATION_MS)).toBe(
      true
    );
    expect(plan.complete).toBe(false);
  });

  it("resumes until a virtual source longer than 24 hours is fully covered", () => {
    const durationMs = 49 * 60 * 60 * 1_000 + 123;
    let cursorMs = 0;
    let nextOrdinal = 0;
    const ranges = [];
    do {
      const plan = planSubtitleChunks({ durationMs, cursorMs, nextOrdinal });
      expect(plan.chunks.length).toBeLessThanOrEqual(SUBTITLE_PLAN_AHEAD_CHUNKS);
      ranges.push(...plan.chunks);
      cursorMs = plan.nextCursorMs;
      nextOrdinal = plan.nextOrdinal;
    } while (cursorMs < durationMs);

    expect(ranges[0].coreStartMs).toBe(0);
    expect(ranges.at(-1)?.endMs).toBe(durationMs);
    expect(ranges.every((chunk, index) => chunk.ordinal === index)).toBe(true);
  });

  it("keeps arbitrary large ordinals intact", () => {
    const plan = planSubtitleChunks({
      durationMs: 1_198_000,
      cursorMs: 600_000,
      nextOrdinal: 12_345,
    });
    expect(plan.chunks[0].ordinal).toBe(12_345);
    expect(plan.nextOrdinal).toBe(12_346);
  });
});

describe("durable identities", () => {
  it("builds the approved automatic run key", () => {
    expect(automaticSubtitlePipelineKey({ fileId: "f-1", sourceVersion: 7, policyVersion: 3 })).toBe(
      "full:f-1:v7:p3"
    );
  });

  it("makes provider request keys deterministic and input-sensitive", () => {
    const input = {
      pipelineKey: "full:f-1:v7:p3",
      stage: "asr",
      ordinal: 12_345,
      inputHash: "abc",
    };
    expect(subtitleProviderRequestKey(input)).toBe(subtitleProviderRequestKey({ ...input }));
    expect(subtitleProviderRequestKey(input)).not.toBe(
      subtitleProviderRequestKey({ ...input, inputHash: "different" })
    );
  });

  it("uses full ordinals and immutable identity in checkpoint paths", () => {
    const key = subtitleCheckpointKey({
      fileId: "file/one",
      sourceVersion: 2,
      runId: "run one",
      stage: "asr",
      ordinal: 12_345,
      inputHash: "deadbeef",
    });
    expect(key).toBe("subtitles/v2/file%2Fone/v2/run%20one/asr/12345/deadbeef.v1.json");
  });
});

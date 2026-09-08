import { beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueJob } = vi.hoisted(() => ({ enqueueJob: vi.fn() }));
vi.mock("@/shared/infrastructure/queue", () => ({ enqueueJob }));

import {
  enqueueMediaInspection,
  mediaMetadataReset,
  shouldInspectMedia,
} from "./media-inspection";

const video = {
  id: "00000000-0000-4000-8000-000000000001",
  r2Key: "users/u/video.mp4",
  mimeType: "video/mp4",
  encrypted: false,
  version: 3,
};

describe("media inspection enqueue", () => {
  beforeEach(() => enqueueJob.mockReset().mockResolvedValue(true));

  it("accepts plaintext audio/video and rejects notes, ciphertext, and other files", () => {
    expect(shouldInspectMedia(video)).toBe(true);
    expect(shouldInspectMedia({ ...video, mimeType: "audio/mpeg" })).toBe(true);
    expect(shouldInspectMedia({ ...video, encrypted: true })).toBe(false);
    expect(shouldInspectMedia({ ...video, isNote: true })).toBe(false);
    expect(shouldInspectMedia({ ...video, mimeType: "application/pdf" })).toBe(
      false,
    );
  });

  it("deduplicates each immutable version with a deterministic job id", async () => {
    await expect(enqueueMediaInspection(video)).resolves.toBe(true);
    expect(enqueueJob).toHaveBeenCalledWith(
      "inspect_media",
      {
        fileId: video.id,
        r2Key: video.r2Key,
        mimeType: video.mimeType,
        version: 3,
      },
      { jobId: `inspect-${video.id}-v3` },
    );
  });

  it("does not touch the queue for an ineligible file", async () => {
    await expect(
      enqueueMediaInspection({ ...video, encrypted: true }),
    ).resolves.toBe(false);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("clears every derived field before bytes are replaced", () => {
    expect(mediaMetadataReset()).toEqual({
      mediaDurationMs: null,
      mediaWidth: null,
      mediaHeight: null,
      mediaFps: null,
      mediaVideoCodec: null,
      mediaAudioCodec: null,
      mediaBitrateBps: null,
      mediaContainer: null,
      mediaFaststart: null,
      mediaCompatible: null,
      mediaCompatibilityReason: null,
      mediaInspectedAt: null,
    });
  });
});

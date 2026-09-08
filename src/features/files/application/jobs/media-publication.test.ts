import { describe, expect, it, vi } from "vitest";
import {
  createMediaPublicationCoordinator,
  type MediaPublicationTransaction,
} from "./media-publication";
import type {
  ExtractedAudioPublication,
  MediaFileState,
  MediaOperation,
} from "./media-worker-core";

const source: MediaFileState = {
  id: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  folderId: null,
  name: "movie.mp4",
  r2Key: "users/u/movie.mp4",
  mimeType: "video/mp4",
  sizeBytes: 1_000,
  version: 4,
  encrypted: false,
  isNote: false,
  status: "ready",
  deletedAt: null,
  restoreBatchId: null,
};

const publication: ExtractedAudioPublication = {
  operationId: "00000000-0000-4000-8000-000000000010",
  outputFileId: "00000000-0000-4000-8000-000000000011",
  fileId: source.id,
  r2Key: source.r2Key,
  mimeType: source.mimeType,
  version: source.version,
  userId: source.userId,
  folderId: source.folderId,
  name: source.name,
  stagingKey: "media-staging/op/audio.mp3",
  outputKey: "users/u/audio.mp3",
  sizeBytes: 500,
  outputMimeType: "audio/mpeg",
  outputName: "movie.mp3",
  outputFile: null,
};

function operation(overrides: Partial<MediaOperation> = {}): MediaOperation {
  return {
    id: publication.operationId,
    kind: "extract_audio",
    sourceFileId: source.id,
    sourceR2Key: source.r2Key,
    sourceMimeType: source.mimeType,
    sourceVersion: source.version,
    outputFileId: publication.outputFileId,
    stagingKey: publication.stagingKey,
    status: "staged",
    outputSizeBytes: publication.sizeBytes,
    outputMimeType: publication.mimeType,
    outputName: publication.outputName,
    ...overrides,
  };
}

function setup() {
  const output = { ...source, id: publication.outputFileId, r2Key: publication.outputKey };
  const tx: MediaPublicationTransaction = {
    lockOperation: vi.fn(async () => operation()),
    lockExactFile: vi.fn(async () => source),
    loadFile: vi.fn(async () => output),
    lockOwner: vi.fn(async () => ({ quotaBytes: 0, usedBytes: 9_000, reservedBytes: 1_000 })),
    setOperationStatus: vi.fn(async () => undefined),
    updateTrimFile: vi.fn(async () => true),
    insertExtractedOutput: vi.fn(async () => output),
    finalizeExtractedOutput: vi.fn(async () => output),
  };
  const coordinator = createMediaPublicationCoordinator({
    transaction: async (work) => work(tx),
  });
  return { tx, coordinator };
}

describe("media publication coordinator", () => {
  it("treats a non-positive storage quota as unlimited", async () => {
    const h = setup();
    const publish = vi.fn(async () => undefined);
    await expect(h.coordinator.publishExtractedAudio(publication, publish)).resolves.toMatchObject({
      outcome: "completed",
    });
    expect(publish).toHaveBeenCalledOnce();
  });

  it("refuses a colliding output id without publishing or mutating that row", async () => {
    const h = setup();
    vi.mocked(h.tx.insertExtractedOutput).mockResolvedValue(null);
    const publish = vi.fn(async () => undefined);
    await expect(h.coordinator.publishExtractedAudio(publication, publish)).resolves.toEqual({
      outcome: "stale",
      file: null,
    });
    expect(publish).not.toHaveBeenCalled();
    expect(h.tx.finalizeExtractedOutput).not.toHaveBeenCalled();
  });
});

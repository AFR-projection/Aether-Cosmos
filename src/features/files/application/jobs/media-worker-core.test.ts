import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMediaWorkerCore,
  type MediaFileState,
  type MediaOperation,
  type MediaWorkerCoreDependencies,
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

function operation(overrides: Partial<MediaOperation> = {}): MediaOperation {
  return {
    id: overrides.id ?? "00000000-0000-4000-8000-000000000010",
    kind: "trim",
    sourceFileId: source.id,
    sourceR2Key: source.r2Key,
    sourceMimeType: source.mimeType,
    sourceVersion: source.version,
    outputFileId: null,
    stagingKey: `media-staging/${overrides.id ?? "00000000-0000-4000-8000-000000000010"}/trim.mp4`,
    status: "queued",
    outputSizeBytes: null,
    outputMimeType: null,
    outputName: null,
    ...overrides,
  };
}

function setup() {
  let file: MediaFileState | null = { ...source };
  let outputFile: MediaFileState | null = null;
  let op = operation();
  const calls: string[] = [];
  const deps: MediaWorkerCoreDependencies = {
    loadFile: vi.fn(async (fileId) =>
      fileId === file?.id ? file : fileId === outputFile?.id ? outputFile : null,
    ),
    ensureOperation: vi.fn(async (seed) => {
      if (op.id === seed.id) return op;
      op = seed;
      return op;
    }),
    markOperationStaged: vi.fn(async (_id, output) => {
      op = {
        ...op,
        status: "staged",
        stagingKey: output.stagingKey,
        outputSizeBytes: output.sizeBytes,
        outputMimeType: output.mimeType,
        outputName: output.name ?? null,
      };
      return op;
    }),
    markOperationTerminal: vi.fn(async (_id, status) => {
      op = { ...op, status };
    }),
    transformTrim: vi.fn(async () => {
      calls.push("transform");
      return { body: Buffer.from("trimmed"), sizeBytes: 7 };
    }),
    transformAudio: vi.fn(async () => ({
      body: Buffer.from("audio"),
      sizeBytes: 5,
      mimeType: "audio/mpeg",
      extension: ".mp3",
    })),
    inspect: vi.fn(async () => ({ mediaDurationMs: 12_000 })),
    renderThumbnails: vi.fn(async () => [
      { size: 300, body: Buffer.from("thumb") },
    ]),
    putObject: vi.fn(async (key) => calls.push(`put:${key}`)),
    copyObject: vi.fn(async (from, to) => calls.push(`copy:${from}->${to}`)),
    deleteObjects: vi.fn(async () => undefined),
    persistInspection: vi.fn(async () => true),
    repairStorageAccounting: vi.fn(async () => undefined),
    publishThumbnails: vi.fn(async (_expected, thumbnailKey, publish) => {
      calls.push(`claim-thumb:${thumbnailKey}`);
      await publish();
      return true;
    }),
    publishTrim: vi.fn(async (_input, publish) => {
      calls.push("claim-trim");
      await publish();
      op = { ...op, status: "completed" };
      return "completed" as const;
    }),
    publishExtractedAudio: vi.fn(async (input, publish) => {
      calls.push(`claim-audio:${input.outputFileId}`);
      expect(input.mimeType).toBe(source.mimeType);
      expect(input.outputMimeType).toBe("audio/mpeg");
      await publish();
      outputFile = {
        ...source,
        id: input.outputFileId,
        name: input.outputName,
        r2Key: input.outputKey,
        mimeType: input.outputMimeType,
        sizeBytes: input.sizeBytes,
        version: 1,
      };
      op = {
        ...op,
        status: "completed",
        outputFileId: input.outputFileId,
        outputSizeBytes: input.sizeBytes,
        outputMimeType: input.mimeType,
        outputName: input.outputName,
      };
      return { outcome: "completed" as const, file: outputFile };
    }),
    enqueue: vi.fn(async (type, _data, jobId) => calls.push(`queue:${type}:${jobId}`)),
    buildOutputKey: vi.fn((userId, fileId, name) => `${userId}/${fileId}/${name}`),
  };
  return {
    deps,
    calls,
    getFile: () => file,
    setFile: (next: MediaFileState | null) => {
      file = next;
    },
    setOutputFile: (next: MediaFileState | null) => {
      outputFile = next;
    },
    getOperation: () => op,
    setOperation: (next: MediaOperation) => {
      op = next;
    },
  };
}

const trimInput = {
  operationId: "00000000-0000-4000-8000-000000000010",
  fileId: source.id,
  r2Key: source.r2Key,
  mimeType: source.mimeType,
  version: source.version,
  startSeconds: 10,
  endSeconds: 20,
};

const exact = {
  fileId: source.id,
  r2Key: source.r2Key,
  mimeType: source.mimeType,
  version: source.version,
};

describe("media worker core", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["key", { r2Key: "replacement" }],
    ["MIME", { mimeType: "application/octet-stream" }],
    ["version", { version: source.version + 1 }],
    ["encryption", { encrypted: true }],
    ["note state", { isNote: true }],
    ["readiness", { status: "uploading" }],
    ["deletion", { deletedAt: new Date() }],
    ["restore staging", { restoreBatchId: "restore" }],
  ])("does not probe or persist when %s changed", async (_label, changed) => {
    const h = setup();
    h.setFile({ ...source, ...changed });
    await createMediaWorkerCore(h.deps).inspectMedia(exact);
    expect(h.deps.inspect).not.toHaveBeenCalled();
    expect(h.deps.persistInspection).not.toHaveBeenCalled();
  });

  it("treats a zero-row final inspection CAS as a stale no-op", async () => {
    const h = setup();
    vi.mocked(h.deps.persistInspection).mockResolvedValue(false);
    await expect(createMediaWorkerCore(h.deps).inspectMedia(exact)).resolves.toBe("stale");
    expect(h.deps.inspect).toHaveBeenCalledOnce();
  });

  it("does not transform or publish a stale trim job", async () => {
    const h = setup();
    h.setFile({ ...source, version: source.version + 1 });
    await expect(createMediaWorkerCore(h.deps).trimMedia(trimInput)).resolves.toBe("stale");
    expect(h.deps.transformTrim).not.toHaveBeenCalled();
    expect(h.deps.putObject).not.toHaveBeenCalled();
    expect(h.deps.copyObject).not.toHaveBeenCalled();
  });

  it("does not transform when an operation id belongs to another source", async () => {
    const h = setup();
    h.setOperation(operation({ sourceFileId: "00000000-0000-4000-8000-000000000099" }));
    await expect(createMediaWorkerCore(h.deps).trimMedia(trimInput)).resolves.toBe("stale");
    expect(h.deps.transformTrim).not.toHaveBeenCalled();
    expect(h.deps.publishTrim).not.toHaveBeenCalled();
  });

  it("stages trim bytes before an exact-state publication claim", async () => {
    const h = setup();
    await expect(createMediaWorkerCore(h.deps).trimMedia(trimInput)).resolves.toBe("completed");
    expect(h.calls.slice(0, 4)).toEqual([
      "transform",
      `put:media-staging/${trimInput.operationId}/trim.mp4`,
      "claim-trim",
      `copy:media-staging/${trimInput.operationId}/trim.mp4->${source.r2Key}`,
    ]);
  });

  it("uses the source container extension for trim staging", async () => {
    const h = setup();
    const webm = {
      ...trimInput,
      r2Key: "users/u/movie.webm",
      mimeType: "video/webm",
    };
    h.setFile({ ...source, r2Key: webm.r2Key, mimeType: webm.mimeType });
    h.setOperation(
      operation({
        id: "00000000-0000-4000-8000-000000000099",
        status: "completed",
      }),
    );
    await createMediaWorkerCore(h.deps).trimMedia(webm);
    expect(h.deps.putObject).toHaveBeenCalledWith(
      `media-staging/${trimInput.operationId}/trim.webm`,
      expect.any(Buffer),
      "video/webm",
    );
  });

  it("repairs deterministic trim derivatives after publication completed", async () => {
    const h = setup();
    h.setOperation(operation({ status: "completed" }));
    await createMediaWorkerCore(h.deps).trimMedia(trimInput);
    expect(h.deps.transformTrim).not.toHaveBeenCalled();
    expect(h.deps.publishTrim).not.toHaveBeenCalled();
    expect(h.calls).toContain(
      `queue:generate_thumbnail:thumb-${source.id}-v${source.version}`,
    );
    expect(h.calls).toContain(
      `queue:inspect_media:inspect-${source.id}-v${source.version}`,
    );
  });

  it("repairs trim accounting before deterministic derivatives after publication completed", async () => {
    const h = setup();
    h.setOperation(operation({ status: "completed" }));
    await createMediaWorkerCore(h.deps).trimMedia(trimInput);
    expect(h.deps.repairStorageAccounting).toHaveBeenCalledWith(source.userId);
    expect(vi.mocked(h.deps.repairStorageAccounting)).toHaveBeenCalledBefore(
      vi.mocked(h.deps.enqueue),
    );
  });

  it("republishes a staged trim on retry without running ffmpeg again", async () => {
    const h = setup();
    h.setOperation(operation({ status: "staged", outputSizeBytes: 7 }));
    await createMediaWorkerCore(h.deps).trimMedia(trimInput);
    expect(h.deps.transformTrim).not.toHaveBeenCalled();
    expect(h.deps.copyObject).toHaveBeenCalledOnce();
  });

  it("keeps retryable staged trim state when publication throws", async () => {
    const h = setup();
    vi.mocked(h.deps.publishTrim).mockRejectedValue(new Error("copy failed"));
    await expect(createMediaWorkerCore(h.deps).trimMedia(trimInput)).rejects.toThrow(
      "copy failed",
    );
    expect(h.deps.markOperationTerminal).not.toHaveBeenCalledWith(
      trimInput.operationId,
      "failed",
    );
    expect(h.deps.deleteObjects).not.toHaveBeenCalled();
  });

  it("queues deterministic derivatives only after trim publication completed", async () => {
    const h = setup();
    await createMediaWorkerCore(h.deps).trimMedia(trimInput);
    expect(h.calls).toContain(`queue:generate_thumbnail:thumb-${source.id}-v${source.version}`);
    expect(h.calls).toContain(`queue:inspect_media:inspect-${source.id}-v${source.version}`);
    expect(h.calls.indexOf("claim-trim")).toBeLessThan(
      h.calls.indexOf(`queue:generate_thumbnail:thumb-${source.id}-v${source.version}`),
    );
  });

  it("never publishes thumbnail bytes when the final state claim is stale", async () => {
    const h = setup();
    vi.mocked(h.deps.publishThumbnails).mockResolvedValue(false);
    await expect(createMediaWorkerCore(h.deps).generateThumbnail(exact)).resolves.toBe("stale");
    expect(h.deps.putObject).toHaveBeenCalled();
    expect(h.deps.copyObject).not.toHaveBeenCalled();
  });

  it("cleans staged thumbnail bytes when the final state claim is stale", async () => {
    const h = setup();
    vi.mocked(h.deps.publishThumbnails).mockResolvedValue(false);
    await createMediaWorkerCore(h.deps).generateThumbnail(exact);
    expect(h.deps.deleteObjects).toHaveBeenCalledWith([
      `media-staging/thumbnail-${source.id}-v${source.version}/300.webp`,
    ]);
  });

  it("cleans staged thumbnail bytes when publication throws", async () => {
    const h = setup();
    vi.mocked(h.deps.publishThumbnails).mockRejectedValue(new Error("copy failed"));
    await expect(createMediaWorkerCore(h.deps).generateThumbnail(exact)).rejects.toThrow(
      "copy failed",
    );
    expect(h.deps.deleteObjects).toHaveBeenCalledWith([
      `media-staging/thumbnail-${source.id}-v${source.version}/300.webp`,
    ]);
  });

  it("publishes thumbnails to immutable version-scoped keys", async () => {
    const h = setup();
    await createMediaWorkerCore(h.deps).generateThumbnail(exact);
    expect(h.calls).toContain(
      `copy:media-staging/thumbnail-${source.id}-v${source.version}/300.webp->thumbnails/${source.id}/v${source.version}/300.webp`,
    );
  });

  it("resumes staged audio from its persisted final key without running ffmpeg", async () => {
    const h = setup();
    const input = {
      operationId: "00000000-0000-4000-8000-000000000020",
      outputFileId: "00000000-0000-4000-8000-000000000021",
      fileId: source.id,
      r2Key: source.r2Key,
      mimeType: source.mimeType,
      version: source.version,
      userId: source.userId,
      folderId: source.folderId,
      name: source.name,
    };
    h.setOperation(
      operation({
        id: input.operationId,
        kind: "extract_audio",
        outputFileId: input.outputFileId,
        stagingKey: `media-staging/${input.operationId}/audio.mp3`,
        status: "staged",
        outputSizeBytes: 5,
        outputMimeType: "audio/mpeg",
        outputName: "movie.mp3",
      }),
    );
    await createMediaWorkerCore(h.deps).extractAudio(input);
    expect(h.deps.transformAudio).not.toHaveBeenCalled();
    expect(h.deps.copyObject).toHaveBeenCalledWith(
      `media-staging/${input.operationId}/audio.mp3`,
      `${source.userId}/${input.outputFileId}/movie.mp3`,
    );
  });

  it("repairs completed audio derivatives from the stable output file", async () => {
    const h = setup();
    const input = {
      operationId: "00000000-0000-4000-8000-000000000020",
      outputFileId: "00000000-0000-4000-8000-000000000021",
      fileId: source.id,
      r2Key: source.r2Key,
      mimeType: source.mimeType,
      version: source.version,
      userId: source.userId,
      folderId: source.folderId,
      name: source.name,
    };
    const audio = {
      ...source,
      id: input.outputFileId,
      name: "movie.mp3",
      r2Key: `${source.userId}/${input.outputFileId}/movie.mp3`,
      mimeType: "audio/mpeg",
      sizeBytes: 5,
      version: 1,
    };
    h.setOutputFile(audio);
    h.setOperation(
      operation({
        id: input.operationId,
        kind: "extract_audio",
        outputFileId: input.outputFileId,
        status: "completed",
        outputSizeBytes: 5,
        outputMimeType: audio.mimeType,
        outputName: audio.name,
      }),
    );
    await createMediaWorkerCore(h.deps).extractAudio(input);
    expect(h.deps.transformAudio).not.toHaveBeenCalled();
    expect(h.deps.publishExtractedAudio).not.toHaveBeenCalled();
    expect(h.calls).toContain(
      `queue:generate_thumbnail:thumb-${audio.id}-v${audio.version}`,
    );
    expect(h.calls).toContain(
      `queue:inspect_media:inspect-${audio.id}-v${audio.version}`,
    );
  });

  it("repairs completed audio accounting before deterministic derivatives", async () => {
    const h = setup();
    const input = {
      operationId: "00000000-0000-4000-8000-000000000020",
      outputFileId: "00000000-0000-4000-8000-000000000021",
      fileId: source.id,
      r2Key: source.r2Key,
      mimeType: source.mimeType,
      version: source.version,
      userId: source.userId,
      folderId: source.folderId,
      name: source.name,
    };
    h.setOutputFile({
      ...source,
      id: input.outputFileId,
      r2Key: `${source.userId}/${input.outputFileId}/movie.mp3`,
      mimeType: "audio/mpeg",
      version: 1,
    });
    h.setOperation(
      operation({
        id: input.operationId,
        kind: "extract_audio",
        outputFileId: input.outputFileId,
        status: "completed",
      }),
    );
    await createMediaWorkerCore(h.deps).extractAudio(input);
    expect(h.deps.repairStorageAccounting).toHaveBeenCalledWith(source.userId);
    expect(vi.mocked(h.deps.repairStorageAccounting)).toHaveBeenCalledBefore(
      vi.mocked(h.deps.enqueue),
    );
  });

  it("keeps retryable staged audio state when publication throws", async () => {
    const h = setup();
    const input = {
      operationId: "00000000-0000-4000-8000-000000000020",
      outputFileId: "00000000-0000-4000-8000-000000000021",
      fileId: source.id,
      r2Key: source.r2Key,
      mimeType: source.mimeType,
      version: source.version,
      userId: source.userId,
      folderId: source.folderId,
      name: source.name,
    };
    h.setOperation(
      operation({
        id: input.operationId,
        kind: "extract_audio",
        outputFileId: input.outputFileId,
        stagingKey: `media-staging/${input.operationId}/audio`,
      }),
    );
    vi.mocked(h.deps.publishExtractedAudio).mockRejectedValue(new Error("copy failed"));
    await expect(createMediaWorkerCore(h.deps).extractAudio(input)).rejects.toThrow(
      "copy failed",
    );
    expect(h.deps.markOperationTerminal).not.toHaveBeenCalledWith(
      input.operationId,
      "failed",
    );
    expect(h.deps.deleteObjects).not.toHaveBeenCalled();
  });

  it("converges extracted-audio retries on one output row and object", async () => {
    const h = setup();
    h.setOperation(operation({ kind: "extract_audio" }));
    const input = {
      operationId: "00000000-0000-4000-8000-000000000020",
      outputFileId: "00000000-0000-4000-8000-000000000021",
      fileId: source.id,
      r2Key: source.r2Key,
      mimeType: source.mimeType,
      version: source.version,
      userId: source.userId,
      folderId: source.folderId,
      name: source.name,
    };
    const core = createMediaWorkerCore(h.deps);
    await core.extractAudio(input);
    h.setOperation({
      ...h.getOperation(),
      id: input.operationId,
      kind: "extract_audio",
      status: "completed",
      outputFileId: input.outputFileId,
    });
    await core.extractAudio(input);
    expect(h.deps.transformAudio).toHaveBeenCalledOnce();
    expect(h.deps.publishExtractedAudio).toHaveBeenCalledOnce();
  });
});

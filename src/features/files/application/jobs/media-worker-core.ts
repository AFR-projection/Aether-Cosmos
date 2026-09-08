import type { JobType } from "@/shared/infrastructure/queue";
import { containerExtensionFor } from "@files/domain/services/media-edit";

export type MediaOperationKind = "trim" | "extract_audio";
export type MediaOperationStatus =
  | "queued"
  | "staged"
  | "publishing"
  | "completed"
  | "stale"
  | "failed";

export type MediaFileState = {
  id: string;
  userId: string;
  folderId: string | null;
  name: string;
  r2Key: string;
  mimeType: string;
  sizeBytes: number;
  version: number;
  encrypted: boolean;
  isNote: boolean;
  status: string;
  deletedAt: Date | null;
  restoreBatchId: string | null;
};

export type MediaOperation = {
  id: string;
  kind: MediaOperationKind;
  sourceFileId: string;
  sourceR2Key: string;
  sourceMimeType: string;
  sourceVersion: number;
  outputFileId: string | null;
  stagingKey: string;
  status: MediaOperationStatus;
  outputSizeBytes: number | null;
  outputMimeType: string | null;
  outputName: string | null;
};

export type ExactMediaState = {
  fileId: string;
  r2Key: string;
  mimeType: string;
  version: number;
};

export type InspectionValues = {
  mediaDurationMs?: number | null;
  mediaWidth?: number | null;
  mediaHeight?: number | null;
  mediaFps?: number | null;
  mediaVideoCodec?: string | null;
  mediaAudioCodec?: string | null;
  mediaBitrateBps?: number | null;
  mediaContainer?: string | null;
  mediaFaststart?: boolean | null;
  mediaCompatible?: boolean | null;
  mediaCompatibilityReason?: string | null;
};

export type Thumbnail = { size: number; body: Buffer };
export type ProducedMedia = {
  body: Buffer;
  sizeBytes: number;
  mimeType?: string;
  extension?: string;
};

export type ExtractedAudioInput = ExactMediaState & {
  operationId: string;
  outputFileId: string;
  userId: string;
  folderId: string | null;
  name: string;
};

export type ExtractedAudioFile = MediaFileState;

export type MediaWorkerCoreDependencies = {
  loadFile(fileId: string): Promise<MediaFileState | null>;
  ensureOperation(seed: MediaOperation): Promise<MediaOperation>;
  markOperationStaged(
    operationId: string,
    output: {
      stagingKey: string;
      sizeBytes: number;
      mimeType: string | null;
      name?: string | null;
    },
  ): Promise<MediaOperation>;
  markOperationTerminal(
    operationId: string,
    status: Extract<MediaOperationStatus, "stale" | "failed">,
  ): Promise<void>;
  transformTrim(input: TrimMediaInput): Promise<ProducedMedia>;
  transformAudio(input: ExtractedAudioInput): Promise<Required<ProducedMedia>>;
  inspect(input: ExactMediaState): Promise<InspectionValues>;
  renderThumbnails(input: ExactMediaState): Promise<Thumbnail[]>;
  putObject(key: string, body: Buffer, contentType: string): Promise<unknown>;
  copyObject(sourceKey: string, destinationKey: string): Promise<unknown>;
  deleteObjects(keys: string[]): Promise<unknown>;
  persistInspection(expected: ExactMediaState, values: InspectionValues): Promise<boolean>;
  repairStorageAccounting(userId: string): Promise<void>;
  publishThumbnails(
    expected: ExactMediaState,
    thumbnailKey: string,
    publish: () => Promise<void>,
  ): Promise<boolean>;
  publishTrim(
    input: TrimPublicationInput,
    publish: () => Promise<void>,
  ): Promise<"completed" | "stale">;
  publishExtractedAudio(
    input: ExtractedAudioPublication,
    publish: () => Promise<void>,
  ): Promise<{ outcome: "completed" | "stale"; file: ExtractedAudioFile | null }>;
  enqueue(type: JobType, data: Record<string, unknown>, jobId: string): Promise<unknown>;
  buildOutputKey(userId: string, fileId: string, name: string): string;
};

export type TrimMediaInput = ExactMediaState & {
  operationId: string;
  startSeconds: number;
  endSeconds: number;
};

export type TrimPublicationInput = TrimMediaInput & {
  stagingKey: string;
  sizeBytes: number;
};

export type ExtractedAudioPublication = ExtractedAudioInput & {
  stagingKey: string;
  outputKey: string;
  sizeBytes: number;
  outputMimeType: string;
  outputName: string;
  outputFile: ExtractedAudioFile | null;
};

type WorkerOutcome = "completed" | "stale";

function matchesExactState(
  file: MediaFileState | null,
  expected: ExactMediaState,
): file is MediaFileState {
  return !!file &&
    file.id === expected.fileId &&
    file.r2Key === expected.r2Key &&
    file.mimeType === expected.mimeType &&
    file.version === expected.version &&
    !file.encrypted &&
    !file.isNote &&
    file.status === "ready" &&
    file.deletedAt === null &&
    file.restoreBatchId === null;
}

function trimSeed(input: TrimMediaInput): MediaOperation {
  const extension = containerExtensionFor(input.mimeType);
  if (!extension) throw new Error("Unsupported trim container");
  return {
    id: input.operationId,
    kind: "trim",
    sourceFileId: input.fileId,
    sourceR2Key: input.r2Key,
    sourceMimeType: input.mimeType,
    sourceVersion: input.version,
    outputFileId: null,
    stagingKey: `media-staging/${input.operationId}/trim.${extension}`,
    status: "queued",
    outputSizeBytes: null,
    outputMimeType: input.mimeType,
    outputName: null,
  };
}

function extractionSeed(input: ExtractedAudioInput): MediaOperation {
  return {
    id: input.operationId,
    kind: "extract_audio",
    sourceFileId: input.fileId,
    sourceR2Key: input.r2Key,
    sourceMimeType: input.mimeType,
    sourceVersion: input.version,
    outputFileId: input.outputFileId,
    stagingKey: `media-staging/${input.operationId}/audio`,
    status: "queued",
    outputSizeBytes: null,
    outputMimeType: null,
    outputName: null,
  };
}

function operationMatchesSeed(operation: MediaOperation, seed: MediaOperation): boolean {
  return operation.id === seed.id &&
    operation.kind === seed.kind &&
    operation.sourceFileId === seed.sourceFileId &&
    operation.sourceR2Key === seed.sourceR2Key &&
    operation.sourceMimeType === seed.sourceMimeType &&
    operation.sourceVersion === seed.sourceVersion &&
    operation.outputFileId === seed.outputFileId;
}

async function enqueueDerivatives(
  deps: MediaWorkerCoreDependencies,
  file: ExactMediaState,
): Promise<void> {
  await deps.enqueue(
    "generate_thumbnail",
    {
      fileId: file.fileId,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      version: file.version,
    },
    `thumb-${file.fileId}-v${file.version}`,
  );
  await deps.enqueue(
    "inspect_media",
    {
      fileId: file.fileId,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      version: file.version,
    },
    `inspect-${file.fileId}-v${file.version}`,
  );
}

export function createMediaWorkerCore(deps: MediaWorkerCoreDependencies) {
  async function inspectMedia(input: ExactMediaState): Promise<WorkerOutcome> {
    const file = await deps.loadFile(input.fileId);
    if (!matchesExactState(file, input)) return "stale";
    if (!input.mimeType.startsWith("video/") && !input.mimeType.startsWith("audio/")) {
      return "stale";
    }
    const inspected = await deps.inspect(input);
    return (await deps.persistInspection(input, inspected)) ? "completed" : "stale";
  }

  async function generateThumbnail(input: ExactMediaState): Promise<WorkerOutcome> {
    const file = await deps.loadFile(input.fileId);
    if (!matchesExactState(file, input)) return "stale";
    const thumbnails = await deps.renderThumbnails(input);
    if (thumbnails.length === 0) return "stale";
    const stagingPrefix = `media-staging/thumbnail-${input.fileId}-v${input.version}`;
    await Promise.all(
      thumbnails.map((thumbnail) =>
        deps.putObject(
          `${stagingPrefix}/${thumbnail.size}.webp`,
          thumbnail.body,
          "image/webp",
        ),
      ),
    );
    const primary = `thumbnails/${input.fileId}/v${input.version}/300.webp`;
    const stagedKeys = thumbnails.map(
      (thumbnail) => `${stagingPrefix}/${thumbnail.size}.webp`,
    );
    let published = false;
    try {
      published = await deps.publishThumbnails(input, primary, async () => {
        for (const thumbnail of thumbnails) {
          await deps.copyObject(
            `${stagingPrefix}/${thumbnail.size}.webp`,
            `thumbnails/${input.fileId}/v${input.version}/${thumbnail.size}.webp`,
          );
        }
      });
    } finally {
      await deps.deleteObjects(stagedKeys);
    }
    return published ? "completed" : "stale";
  }

  async function trimMedia(input: TrimMediaInput): Promise<WorkerOutcome> {
    const file = await deps.loadFile(input.fileId);
    if (!matchesExactState(file, input)) return "stale";
    const seed = trimSeed(input);
    let operation = await deps.ensureOperation(seed);
    if (!operationMatchesSeed(operation, seed)) return "stale";
    if (operation.status === "completed") {
      await deps.repairStorageAccounting(file.userId);
      await enqueueDerivatives(deps, input);
      return "completed";
    }
    if (operation.status === "stale" || operation.status === "failed") return "stale";

    if (operation.status === "queued") {
      const output = await deps.transformTrim(input);
      if (output.sizeBytes <= 0) throw new Error("ffmpeg produced an empty file");
      await deps.putObject(operation.stagingKey, output.body, input.mimeType);
      operation = await deps.markOperationStaged(input.operationId, {
        stagingKey: operation.stagingKey,
        sizeBytes: output.sizeBytes,
        mimeType: input.mimeType,
      });
    }
    if (operation.outputSizeBytes === null) {
      throw new Error("Staged trim operation has no output size");
    }

    const outcome = await deps.publishTrim(
      {
        ...input,
        stagingKey: operation.stagingKey,
        sizeBytes: operation.outputSizeBytes,
      },
      () => deps.copyObject(operation.stagingKey, input.r2Key).then(() => undefined),
    );
    if (outcome === "stale") {
      await deps.markOperationTerminal(input.operationId, "stale");
      await deps.deleteObjects([operation.stagingKey]);
      return "stale";
    }
    await deps.deleteObjects([operation.stagingKey]);
    await enqueueDerivatives(deps, input);
    return "completed";
  }

  async function extractAudio(input: ExtractedAudioInput): Promise<WorkerOutcome> {
    const file = await deps.loadFile(input.fileId);
    if (!matchesExactState(file, input) || !input.mimeType.startsWith("video/")) {
      return "stale";
    }
    const seed = extractionSeed(input);
    let operation = await deps.ensureOperation(seed);
    if (!operationMatchesSeed(operation, seed)) return "stale";
    if (operation.status === "completed") {
      const outputFile = operation.outputFileId
        ? await deps.loadFile(operation.outputFileId)
        : null;
      if (outputFile && matchesExactState(outputFile, {
        fileId: outputFile.id,
        r2Key: outputFile.r2Key,
        mimeType: outputFile.mimeType,
        version: outputFile.version,
      })) {
        await deps.repairStorageAccounting(input.userId);
        await enqueueDerivatives(deps, {
          fileId: outputFile.id,
          r2Key: outputFile.r2Key,
          mimeType: outputFile.mimeType,
          version: outputFile.version,
        });
      }
      return "completed";
    }
    if (operation.status === "stale" || operation.status === "failed") return "stale";

    let outputMime = operation.outputMimeType;
    let outputName = operation.outputName;
    if (operation.status === "queued") {
      const output = await deps.transformAudio(input);
      if (output.sizeBytes <= 0) throw new Error("ffmpeg produced an empty file");
      outputMime = output.mimeType;
      outputName = input.name.replace(/\.[^.]+$/, "") + output.extension;
      const stagedKey = `${operation.stagingKey}${output.extension}`;
      await deps.putObject(stagedKey, output.body, output.mimeType);
      operation = await deps.markOperationStaged(input.operationId, {
        stagingKey: stagedKey,
        sizeBytes: output.sizeBytes,
        mimeType: output.mimeType,
        name: outputName,
      });
    }
    if (!operation.outputSizeBytes || !outputMime || !outputName) {
      throw new Error("Staged audio operation has incomplete output metadata");
    }

    const outputKey = deps.buildOutputKey(input.userId, input.outputFileId, outputName);
    const publication = await deps.publishExtractedAudio(
      {
        ...input,
        stagingKey: operation.stagingKey,
        outputKey,
        sizeBytes: operation.outputSizeBytes,
        outputMimeType: outputMime,
        outputName,
        outputFile: null,
      },
      () => deps.copyObject(operation.stagingKey, outputKey).then(() => undefined),
    );
    if (publication.outcome === "stale") {
      await deps.markOperationTerminal(input.operationId, "stale");
      await deps.deleteObjects([operation.stagingKey]);
      return "stale";
    }
    await deps.deleteObjects([operation.stagingKey]);
    const outputFile = publication.file;
    if (outputFile) {
      await enqueueDerivatives(deps, {
        fileId: outputFile.id,
        r2Key: outputFile.r2Key,
        mimeType: outputFile.mimeType,
        version: outputFile.version,
      });
    }
    return "completed";
  }

  return { inspectMedia, generateThumbnail, trimMedia, extractAudio };
}

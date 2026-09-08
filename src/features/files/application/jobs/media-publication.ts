import type {
  ExactMediaState,
  ExtractedAudioFile,
  ExtractedAudioPublication,
  MediaFileState,
  MediaOperation,
  TrimPublicationInput,
} from "./media-worker-core";

export type StorageOwner = {
  quotaBytes: number;
  usedBytes: number;
  reservedBytes: number;
};

export type MediaPublicationTransaction = {
  lockOperation(operationId: string): Promise<MediaOperation | null>;
  lockExactFile(expected: ExactMediaState): Promise<MediaFileState | null>;
  loadFile(fileId: string): Promise<MediaFileState | null>;
  lockOwner(userId: string): Promise<StorageOwner | null>;
  setOperationStatus(
    operationId: string,
    status: "publishing" | "completed",
  ): Promise<void>;
  updateTrimFile(input: TrimPublicationInput): Promise<boolean>;
  insertExtractedOutput(
    input: ExtractedAudioPublication,
  ): Promise<ExtractedAudioFile | null>;
  finalizeExtractedOutput(
    input: ExtractedAudioPublication,
  ): Promise<ExtractedAudioFile | null>;
};

export type MediaPublicationCoordinatorDependencies = {
  transaction<T>(work: (tx: MediaPublicationTransaction) => Promise<T>): Promise<T>;
};

export function createMediaPublicationCoordinator(
  deps: MediaPublicationCoordinatorDependencies,
) {
  async function publishTrim(
    input: TrimPublicationInput,
    publish: () => Promise<void>,
  ): Promise<"completed" | "stale"> {
    return deps.transaction(async (tx) => {
      const operation = await tx.lockOperation(input.operationId);
      if (!operation || operation.status === "stale" || operation.status === "failed") {
        return "stale";
      }
      if (operation.status === "completed") return "completed";
      if (!(await tx.lockExactFile(input))) return "stale";
      await tx.setOperationStatus(input.operationId, "publishing");
      await publish();
      if (!(await tx.updateTrimFile(input))) {
        throw new Error("Trim source changed while publication lock was held");
      }
      await tx.setOperationStatus(input.operationId, "completed");
      return "completed";
    });
  }

  async function publishExtractedAudio(
    input: ExtractedAudioPublication,
    publish: () => Promise<void>,
  ): Promise<{ outcome: "completed" | "stale"; file: ExtractedAudioFile | null }> {
    return deps.transaction(async (tx) => {
      const operation = await tx.lockOperation(input.operationId);
      if (!operation || operation.status === "stale" || operation.status === "failed") {
        return { outcome: "stale", file: null };
      }
      if (operation.status === "completed") {
        return {
          outcome: "completed",
          file: await tx.loadFile(input.outputFileId),
        };
      }
      if (!(await tx.lockExactFile(input))) {
        return { outcome: "stale", file: null };
      }
      const owner = await tx.lockOwner(input.userId);
      if (!owner) return { outcome: "stale", file: null };
      if (
        owner.quotaBytes > 0 &&
        owner.usedBytes + owner.reservedBytes + input.sizeBytes > owner.quotaBytes
      ) {
        return { outcome: "stale", file: null };
      }
      const created = await tx.insertExtractedOutput(input);
      if (!created) return { outcome: "stale", file: null };
      await tx.setOperationStatus(input.operationId, "publishing");
      await publish();
      const ready = await tx.finalizeExtractedOutput(input);
      if (!ready) throw new Error("Extracted audio output row could not be finalized");
      await tx.setOperationStatus(input.operationId, "completed");
      return { outcome: "completed", file: ready };
    });
  }

  return { publishTrim, publishExtractedAudio };
}

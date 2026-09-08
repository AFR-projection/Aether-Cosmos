import { enqueueJob } from "@/shared/infrastructure/queue";

export type MediaInspectionCandidate = {
  id: string;
  r2Key: string;
  mimeType: string;
  encrypted: boolean;
  isNote?: boolean;
  version?: number;
};

export function mediaMetadataReset() {
  return {
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
  };
}

export function shouldInspectMedia(file: MediaInspectionCandidate): boolean {
  if (file.encrypted || file.isNote || file.r2Key.startsWith("notes/"))
    return false;
  const mime = file.mimeType.toLowerCase().split(";")[0].trim();
  return mime.startsWith("video/") || mime.startsWith("audio/");
}

/**
 * Queue a probe for one immutable file version.
 *
 * The deterministic id collapses retries from upload completion, thumbnail generation, and
 * version restoration into one job. A new object version gets a new id and is inspected again.
 */
export async function enqueueMediaInspection(
  file: MediaInspectionCandidate,
): Promise<boolean> {
  if (!shouldInspectMedia(file)) return false;
  const version =
    Number.isInteger(file.version) && Number(file.version) > 0
      ? Number(file.version)
      : 1;
  return enqueueJob(
    "inspect_media",
    {
      fileId: file.id,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      version,
    },
    { jobId: `inspect-${file.id}-v${version}` },
  );
}

import type { ExactMediaState } from "@files/application/jobs/media-worker-core";
import { ensureSubtitlePipeline } from "@files/application/subtitles/pipeline/ensure";
import { postgresSubtitlePipelineStore } from "./pipeline-store";

/**
 * Production ensure adapter for the media inspection trigger.
 *
 * Wired as `ensureSubtitles` in `workers/index.ts`. Only video/audio rows reach here:
 * `mediaWorkerCore.inspectMedia` already returned "stale" for anything else and
 * `persistInspection` committed the exact state being passed in.
 */
export async function ensureSubtitlesForInspectedMedia(input: ExactMediaState): Promise<unknown> {
  return ensureSubtitlePipeline({ fileId: input.fileId }, postgresSubtitlePipelineStore());
}

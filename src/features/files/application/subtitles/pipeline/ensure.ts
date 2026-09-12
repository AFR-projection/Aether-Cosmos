import { deriveAutomaticSubtitleTargets, subtitleLocaleSetHash } from "@files/domain/services/subtitles/locale-targets";
import { automaticSubtitlePipelineKey } from "@files/domain/services/subtitles/pipeline-planning";
import type { PipelineRun, SourceIdentity, SubtitlePipelineStore } from "./contracts";

export const SUBTITLE_PIPELINE_POLICY_VERSION = 1;
export const ENCRYPTED_UNSUPPORTED_CODE = "ENCRYPTED_SOURCE";

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** Exact immutable identity used by both revalidation and durable idempotency. */
export function sameSourceIdentity(run: PipelineRun, source: SourceIdentity | null): boolean {
  return source !== null &&
    source.deletedAt === null &&
    run.fileId === source.fileId &&
    run.userId === source.userId &&
    run.sourceVersion === source.version &&
    run.sourceR2Key === source.r2Key &&
    run.sourceMimeType === source.mimeType;
}

export type EnsureSubtitlePipelineInput = {
  readonly fileId: string;
  readonly policyVersion?: number;
  /** Injectable for locale reconciliation tests; production intentionally defaults to LOCALES. */
  readonly locales?: readonly string[];
  readonly now?: Date;
};

/**
 * Atomically establishes one run for the exact file version/policy and all app locales.
 * An encrypted source is still recorded: `unsupported` is durable product state, not a thrown error.
 */
export async function ensureSubtitlePipeline(
  input: EnsureSubtitlePipelineInput,
  store: SubtitlePipelineStore
): Promise<{ run: PipelineRun; created: boolean }> {
  const source = await store.loadSource(input.fileId);
  if (!source || source.deletedAt) throw new Error("SUBTITLE_SOURCE_NOT_FOUND");
  positiveSafeInteger(source.version, "source.version");
  const policyVersion = positiveSafeInteger(input.policyVersion ?? SUBTITLE_PIPELINE_POLICY_VERSION, "policyVersion");
  const targets = deriveAutomaticSubtitleTargets("und", input.locales).map((target) => target.language);
  const localeSetHash = subtitleLocaleSetHash(input.locales);
  const requestKey = automaticSubtitlePipelineKey({ fileId: source.fileId, sourceVersion: source.version, policyVersion });

  return store.ensureRun({
    source,
    policyVersion,
    requestKey,
    localeSetHash,
    targets,
    status: source.encrypted ? "unsupported" : "queued",
    unsupportedCode: source.encrypted ? ENCRYPTED_UNSUPPORTED_CODE : undefined,
    now: input.now ?? new Date(),
  });
}

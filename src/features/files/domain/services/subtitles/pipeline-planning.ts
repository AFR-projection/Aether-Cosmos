import { createHash } from "node:crypto";

/** A bounded unit of ASR work; this is not a media-duration limit. */
export const SUBTITLE_CHUNK_DURATION_MS = 600_000;
/** Audio repeated before every chunk after the first to preserve boundary speech. */
export const SUBTITLE_CHUNK_OVERLAP_MS = 2_000;
/** Maximum ranges one planner transaction may create. */
export const SUBTITLE_PLAN_AHEAD_CHUNKS = 24;
export const SUBTITLE_CHECKPOINT_SCHEMA_VERSION = 1;

export type SubtitleChunkRange = {
  readonly ordinal: number;
  readonly startMs: number;
  readonly coreStartMs: number;
  readonly endMs: number;
  readonly overlapBeforeMs: number;
};

export type SubtitleChunkPlan = {
  readonly chunks: readonly SubtitleChunkRange[];
  readonly nextCursorMs: number;
  readonly nextOrdinal: number;
  readonly complete: boolean;
};

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

/**
 * Plans only the next bounded window. Calling this again with the returned cursors eventually
 * covers any duration representable exactly in milliseconds; no duration or ordinal is capped.
 */
export function planSubtitleChunks(input: {
  durationMs: number;
  cursorMs?: number;
  nextOrdinal?: number;
  chunkDurationMs?: number;
  overlapMs?: number;
  maxChunks?: number;
}): SubtitleChunkPlan {
  const durationMs = nonNegativeSafeInteger(input.durationMs, "durationMs");
  let cursorMs = nonNegativeSafeInteger(input.cursorMs ?? 0, "cursorMs");
  let ordinal = nonNegativeSafeInteger(input.nextOrdinal ?? 0, "nextOrdinal");
  const chunkDurationMs = nonNegativeSafeInteger(
    input.chunkDurationMs ?? SUBTITLE_CHUNK_DURATION_MS,
    "chunkDurationMs"
  );
  if (chunkDurationMs === 0) throw new RangeError("chunkDurationMs must be positive");
  const overlapMs = Math.min(
    nonNegativeSafeInteger(input.overlapMs ?? SUBTITLE_CHUNK_OVERLAP_MS, "overlapMs"),
    chunkDurationMs - 1
  );
  const requestedMax = nonNegativeSafeInteger(
    input.maxChunks ?? SUBTITLE_PLAN_AHEAD_CHUNKS,
    "maxChunks"
  );
  const maxChunks = Math.min(requestedMax, SUBTITLE_PLAN_AHEAD_CHUNKS);
  cursorMs = Math.min(cursorMs, durationMs);

  const chunks: SubtitleChunkRange[] = [];
  while (cursorMs < durationMs && chunks.length < maxChunks) {
    const coreStartMs = cursorMs;
    const startMs = Math.max(0, coreStartMs - overlapMs);
    const endMs = Math.min(durationMs, startMs + chunkDurationMs);
    chunks.push({
      ordinal,
      startMs,
      coreStartMs,
      endMs,
      overlapBeforeMs: coreStartMs - startMs,
    });
    cursorMs = endMs;
    ordinal += 1;
  }

  return {
    chunks,
    nextCursorMs: cursorMs,
    nextOrdinal: ordinal,
    complete: cursorMs >= durationMs,
  };
}

/** Stable identity for the automatic full-file policy run described by the pipeline contract. */
export function automaticSubtitlePipelineKey(input: {
  fileId: string;
  sourceVersion: number;
  policyVersion: number;
}): string {
  const version = nonNegativeSafeInteger(input.sourceVersion, "sourceVersion");
  const policy = nonNegativeSafeInteger(input.policyVersion, "policyVersion");
  if (input.fileId.length === 0) throw new RangeError("fileId must not be empty");
  return `full:${input.fileId}:v${version}:p${policy}`;
}

function hashParts(parts: readonly (string | number)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value, "utf8")));
    hash.update(":");
    hash.update(value, "utf8");
  }
  return hash.digest("hex");
}

/** Provider request identity: retries of the same immutable work produce the same key. */
export function subtitleProviderRequestKey(input: {
  pipelineKey: string;
  stage: string;
  ordinal: number;
  targetLanguage?: string;
  inputHash: string;
}): string {
  const ordinal = nonNegativeSafeInteger(input.ordinal, "ordinal");
  return `subtitle-request:${hashParts([
    input.pipelineKey,
    input.stage,
    ordinal,
    input.targetLanguage ?? "",
    input.inputHash,
  ])}`;
}

function pathSegment(value: string, name: string): string {
  if (value.length === 0) throw new RangeError(`${name} must not be empty`);
  return encodeURIComponent(value);
}

/** Immutable checkpoint object key. Ordinals are full path segments and are never padded/truncated. */
export function subtitleCheckpointKey(input: {
  fileId: string;
  sourceVersion: number;
  runId: string;
  stage: string;
  ordinal: number;
  inputHash: string;
  targetLanguage?: string;
  schemaVersion?: number;
}): string {
  const sourceVersion = nonNegativeSafeInteger(input.sourceVersion, "sourceVersion");
  const ordinal = nonNegativeSafeInteger(input.ordinal, "ordinal");
  const schemaVersion = nonNegativeSafeInteger(
    input.schemaVersion ?? SUBTITLE_CHECKPOINT_SCHEMA_VERSION,
    "schemaVersion"
  );
  const target = input.targetLanguage ? `${pathSegment(input.targetLanguage, "targetLanguage")}/` : "";
  return `subtitles/v2/${pathSegment(input.fileId, "fileId")}/v${sourceVersion}/${pathSegment(
    input.runId,
    "runId"
  )}/${pathSegment(input.stage, "stage")}/${target}${ordinal}/${pathSegment(
    input.inputHash,
    "inputHash"
  )}.v${schemaVersion}.json`;
}

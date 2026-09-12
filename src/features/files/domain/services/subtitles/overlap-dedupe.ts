import type { SubtitleCue } from "./vtt";

export const OVERLAP_DEDUPE_TOLERANCE_MS = 2_500;

function textKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function sameBoundaryCue(left: SubtitleCue, right: SubtitleCue, toleranceMs: number): boolean {
  if (textKey(left.text) !== textKey(right.text)) return false;
  const intersects = left.startMs <= right.endMs && right.startMs <= left.endMs;
  return intersects || Math.abs(left.startMs - right.startMs) <= toleranceMs;
}

/**
 * Finds the longest matching suffix/prefix at an overlapped partition boundary. Only that prefix is
 * removed, so a genuine repeated line later in the partition remains. Inputs are never mutated.
 */
export function dedupeOverlappingCueBoundary(
  previousTail: readonly SubtitleCue[],
  incoming: readonly SubtitleCue[],
  toleranceMs: number = OVERLAP_DEDUPE_TOLERANCE_MS
): SubtitleCue[] {
  const tolerance = Number.isFinite(toleranceMs) ? Math.max(0, Math.round(toleranceMs)) : 0;
  const greatestPossible = Math.min(previousTail.length, incoming.length);
  let duplicatePrefix = 0;

  for (let length = greatestPossible; length > 0; length -= 1) {
    const previousOffset = previousTail.length - length;
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (!sameBoundaryCue(previousTail[previousOffset + index], incoming[index], tolerance)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      duplicatePrefix = length;
      break;
    }
  }

  return incoming.slice(duplicatePrefix).map((cue) => ({ ...cue }));
}

/** Produces a deterministic materialization window containing the prior tail exactly once. */
export function stitchOverlappingCuePartitions(
  previousTail: readonly SubtitleCue[],
  incoming: readonly SubtitleCue[],
  toleranceMs: number = OVERLAP_DEDUPE_TOLERANCE_MS
): SubtitleCue[] {
  const uniqueIncoming = dedupeOverlappingCueBoundary(previousTail, incoming, toleranceMs);
  return [...previousTail.map((cue) => ({ ...cue })), ...uniqueIncoming].map((cue, idx) => ({
    ...cue,
    idx,
  }));
}

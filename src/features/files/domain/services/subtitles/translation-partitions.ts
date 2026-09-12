import type { SubtitleCue } from "./vtt";

/** Bounded source + translated cue partition size. */
export const TRANSLATION_PARTITION_MAX_CUES = 80;
export const TRANSLATION_PARTITION_MAX_CHARACTERS = 12_000;
export const TRANSLATION_PARTITION_MAX_BYTES = 256 * 1024;

export type TranslationPartition = {
  readonly ordinal: number;
  readonly offset: number;
  readonly cues: readonly SubtitleCue[];
  readonly characterCount: number;
  readonly serializedBytes: number;
};

function serializedCueBytes(cue: SubtitleCue): number {
  return Buffer.byteLength(JSON.stringify(cue), "utf8");
}

/**
 * Greedily plans bounded requests without dropping input. A single cue exceeding either payload
 * limit is rejected explicitly because it cannot be safely partitioned without changing cue IDs.
 */
export function planTranslationPartitions(
  cues: readonly SubtitleCue[],
  options?: {
    maxCues?: number;
    maxCharacters?: number;
    maxBytes?: number;
    startingOrdinal?: number;
    startingOffset?: number;
  }
): TranslationPartition[] {
  const maxCues = positiveBound(options?.maxCues ?? TRANSLATION_PARTITION_MAX_CUES, "maxCues");
  const maxCharacters = positiveBound(
    options?.maxCharacters ?? TRANSLATION_PARTITION_MAX_CHARACTERS,
    "maxCharacters"
  );
  const maxBytes = positiveBound(options?.maxBytes ?? TRANSLATION_PARTITION_MAX_BYTES, "maxBytes");
  let ordinal = nonNegative(options?.startingOrdinal ?? 0, "startingOrdinal");
  let offset = nonNegative(options?.startingOffset ?? 0, "startingOffset");
  const partitions: TranslationPartition[] = [];
  let current: SubtitleCue[] = [];
  let characters = 0;
  let bytes = 2; // JSON array brackets

  const flush = () => {
    if (current.length === 0) return;
    partitions.push({
      ordinal,
      offset,
      cues: current,
      characterCount: characters,
      serializedBytes: bytes,
    });
    ordinal += 1;
    offset += current.length;
    current = [];
    characters = 0;
    bytes = 2;
  };

  for (const cue of cues) {
    const cueCharacters = cue.text.length;
    const cueBytes = serializedCueBytes(cue);
    const standaloneBytes = cueBytes + 2;
    if (cueCharacters > maxCharacters || standaloneBytes > maxBytes) {
      throw new RangeError(`Cue ${cue.idx} exceeds translation partition bounds`);
    }
    const additionalBytes = cueBytes + (current.length === 0 ? 0 : 1);
    if (
      current.length >= maxCues ||
      characters + cueCharacters > maxCharacters ||
      bytes + additionalBytes > maxBytes
    ) {
      flush();
    }
    current.push(cue);
    characters += cueCharacters;
    bytes += cueBytes + (current.length === 1 ? 0 : 1);
  }
  flush();
  return partitions;
}

/** Deterministic retry split. Leaves are independently checkpointable and successful leaves persist. */
export function bisectTranslationPartition(
  partition: TranslationPartition
): readonly [TranslationPartition, TranslationPartition] | null {
  if (partition.cues.length < 2) return null;
  const middle = Math.floor(partition.cues.length / 2);
  const makeChild = (cues: readonly SubtitleCue[], offset: number, branch: number): TranslationPartition => ({
    ordinal: partition.ordinal * 2 + branch,
    offset,
    cues,
    characterCount: cues.reduce((sum, cue) => sum + cue.text.length, 0),
    serializedBytes: Buffer.byteLength(JSON.stringify(cues), "utf8"),
  });
  return [
    makeChild(partition.cues.slice(0, middle), partition.offset, 1),
    makeChild(partition.cues.slice(middle), partition.offset + middle, 2),
  ];
}

function positiveBound(value: number, name: string): number {
  const result = nonNegative(value, name);
  if (result === 0) throw new RangeError(`${name} must be positive`);
  return result;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

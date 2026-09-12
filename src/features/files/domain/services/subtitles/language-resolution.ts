import { normalizeLanguageTag } from "./languages";

export type LanguageEvidence = {
  readonly language: string;
  /** Milliseconds of usable audio supporting this observation. */
  readonly durationMs: number;
  /** Optional provider confidence in [0, 1]. Defaults to 1. */
  readonly confidence?: number;
};

/**
 * Resolves a track label by supported duration, not chunk count. This avoids a short final chunk
 * outweighing a long one. Ties are deterministic: first observed canonical language wins.
 */
export function resolveWeightedSubtitleLanguage(
  evidence: readonly LanguageEvidence[]
): string | null {
  const weights = new Map<string, { weight: number; first: number }>();
  evidence.forEach((item, index) => {
    const language = normalizeLanguageTag(item.language);
    if (!language || !Number.isFinite(item.durationMs) || item.durationMs <= 0) return;
    const confidence = item.confidence === undefined
      ? 1
      : Math.min(1, Math.max(0, Number.isFinite(item.confidence) ? item.confidence : 0));
    const weight = item.durationMs * confidence;
    if (weight <= 0) return;
    const prior = weights.get(language);
    weights.set(language, {
      weight: (prior?.weight ?? 0) + weight,
      first: prior?.first ?? index,
    });
  });

  let winner: { language: string; weight: number; first: number } | null = null;
  for (const [language, value] of weights) {
    if (
      winner === null ||
      value.weight > winner.weight ||
      (value.weight === winner.weight && value.first < winner.first)
    ) {
      winner = { language, ...value };
    }
  }
  return winner?.language ?? null;
}

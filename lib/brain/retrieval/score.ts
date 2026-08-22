/**
 * Retrieval scoring for the Second Brain — pure, normalized, explainable.
 *
 * Ranking is where a knowledge base either becomes memory or stays a search box.
 * The rule this module exists to enforce: signals are NEVER summed raw. Postgres
 * `ts_rank` is unbounded and set-relative, cosine similarity lives in [-1, 1],
 * importance is [0, 1] and hop distance is an integer — adding those together
 * produces a number that looks like a score and ranks like noise.
 *
 * So every signal is first mapped into [0, 1], then combined as a WEIGHTED MEAN
 * over the signals that actually voted. Two consequences worth stating:
 *
 *  - A missing signal abstains; it does not vote zero. A brain with no embedding
 *    provider must rank exactly as well as it did before embeddings existed, and a
 *    zero-valued semantic leg would instead push every memory down.
 *  - Match evidence and memory quality are separate pools. Quality alone cannot
 *    manufacture relevance: with no match signal at all a candidate cannot score
 *    above {@link QUALITY_SHARE}, so an important, freshly-updated, high-confidence
 *    memory never outranks something the query actually matched.
 *
 * Validity is applied last, as a bounded multiplier: a superseded memory stays
 * retrievable and stays explainable, it just ranks below its replacement. Nothing
 * here deletes or hides knowledge (P5).
 *
 * Everything is deterministic: same inputs and same `now` produce the same score
 * and the same ordering, down to tie-breaks. That is what makes the ranking
 * auditable — {@link RetrievalScore.components} shows every signal, its normalized
 * value, its weight and its contribution, so "why is this memory first" always has
 * an arithmetic answer.
 */

/** Reasons reported to callers. Stable vocabulary — MCP output depends on it. */
export const RETRIEVAL_REASONS = [
  "lexical",
  "semantic",
  "entity",
  "graph",
  "related",
  "recent",
  "important",
] as const;
export type RetrievalReason = (typeof RETRIEVAL_REASONS)[number];

/** Evidence that a candidate is relevant to *this* query. May abstain. */
export type MatchSignal = "lexical" | "semantic" | "entity" | "graph" | "related";

/** Properties of the memory itself, independent of the query. */
export type QualitySignal = "important" | "recent" | "confidence" | "reinforcement";

export type ScoreSignal = MatchSignal | QualitySignal;

/**
 * Relative weights inside the match pool. Lexical leads because it is the only
 * leg with exact evidence — the query words are literally in the text. Semantic
 * follows, graph and relationship proximity are supporting evidence: they say
 * "this is near something relevant", which is weaker than "this is relevant".
 */
export const MATCH_WEIGHTS: Readonly<Record<MatchSignal, number>> = {
  lexical: 1,
  semantic: 0.9,
  entity: 0.8,
  graph: 0.5,
  related: 0.5,
};

/**
 * Relative weights inside the quality pool. `reinforcement` is deliberately the
 * smallest: it is the only signal fed by the system's own past behaviour, and a
 * heavy weight there is how a retrieval feedback loop becomes a runaway (P10).
 */
export const QUALITY_WEIGHTS: Readonly<Record<QualitySignal, number>> = {
  important: 1,
  confidence: 0.8,
  recent: 0.6,
  reinforcement: 0.4,
};

/** Split between the two pools. Match evidence dominates; quality reorders. */
export const MATCH_SHARE = 0.75;
export const QUALITY_SHARE = 0.25;

/**
 * Bounded validity multipliers. `retracted` is heavily demoted but NOT zero:
 * `brain_explain` must still be able to reach it, and a hard zero would make a
 * retracted memory invisible instead of low-ranked (P5: decay affects ranking,
 * never deletion).
 */
export const VALIDITY_MULTIPLIER = {
  active: 1,
  stale: 0.85,
  superseded: 0.4,
  retracted: 0.15,
} as const;
export type ValidityState = keyof typeof VALIDITY_MULTIPLIER;

/** Freshness half-life. A 45-day-old memory is worth half a brand-new one here. */
export const RECENCY_HALF_LIFE_DAYS = 45;
/** Reinforcement half-life: usage that stopped mattering stops counting. */
export const REINFORCEMENT_HALF_LIFE_DAYS = 90;
/** Counts saturate here, so a hot memory cannot climb forever. */
export const RECALL_SATURATION = 20;
export const CONFIRMATION_SATURATION = 5;
/** Per-hop decay for graph proximity: 1 hop = 0.6, 2 hops = 0.36. */
export const GRAPH_HOP_DECAY = 0.6;
/** A signal below this contribution is real but not worth reporting as a reason. */
export const REASON_MIN_CONTRIBUTION = 0.02;
/** Reasons are a headline, not a dump. */
export const MAX_REASONS = 3;

/**
 * Raw, un-normalized inputs for one candidate. Every optional field means "this
 * leg has no opinion" when null or undefined — never "the value is zero".
 */
export type RetrievalFeatures = {
  /** Raw Postgres `ts_rank`. Normalized against the rest of the result set. */
  lexicalRank?: number | null;
  /** Cosine similarity in [-1, 1]. Negative is clamped to 0 (unrelated). */
  semanticSimilarity?: number | null;
  /** Share of the query's entities this memory mentions, [0, 1]. */
  entityOverlap?: number | null;
  /** Graph distance from a seed memory. 0 = the seed itself. */
  graphHops?: number | null;
  /** Strength of a direct relationship to a seed, [0, 1]. */
  relationshipStrength?: number | null;

  /** memories.importance, [0, 1]. */
  importance?: number | null;
  /** memories.confidence, [0, 1]. */
  confidence?: number | null;
  /** Quality of the provenance chain, [0, 1]. Blended into `confidence`. */
  provenanceQuality?: number | null;

  updatedAt?: Date | string | null;
  lastRecalledAt?: Date | string | null;
  recallCount?: number | null;
  confirmationCount?: number | null;

  validityState?: ValidityState | string | null;
};

/** One signal's audited contribution to a score. */
export type ScoreComponent = {
  signal: ScoreSignal;
  pool: "match" | "quality";
  /** Normalized signal value in [0, 1]. */
  value: number;
  /** Weight within its pool, before renormalization. */
  weight: number;
  /** How much of the final score this signal accounts for. */
  contribution: number;
};

export type RetrievalScore = {
  /** Final score in [0, 1]. */
  score: number;
  /** Weighted mean of the match pool, [0, 1]. 0 when nothing matched. */
  matchScore: number;
  /** Weighted mean of the quality pool, [0, 1]. */
  qualityScore: number;
  /** Applied last; see {@link VALIDITY_MULTIPLIER}. */
  validityMultiplier: number;
  /** Headline reasons, strongest first. Empty only when nothing voted at all. */
  whyMatched: RetrievalReason[];
  /** Every signal that voted, strongest contribution first. */
  components: ScoreComponent[];
};

export type ScoreOptions = {
  /** Reference time for the decay functions. Injected so tests are deterministic. */
  now?: Date;
  /**
   * Largest raw lexical rank in the result set, used to normalize this candidate.
   * Defaults to the candidate's own rank, which makes a lone candidate the best
   * lexical match in its own set — correct, since normalization is set-relative.
   */
  lexicalMax?: number | null;
};

const DAY_MS = 86_400_000;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Rounded to 6 places so float noise cannot reorder two equal candidates. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Exponential decay with a half-life, clamped to [0, 1]. A future timestamp scores
 * 1 rather than >1: clock skew must not be a ranking advantage.
 */
export function halfLifeDecay(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays <= 0) return 1;
  if (halfLifeDays <= 0) return 0;
  return clamp01(Math.pow(0.5, ageDays / halfLifeDays));
}

/** Log-saturating count in [0, 1]. Doubling a large count barely moves it. */
export function saturate(count: number, ceiling: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  if (ceiling <= 0) return 1;
  return clamp01(Math.log1p(count) / Math.log1p(ceiling));
}

function ageInDays(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / DAY_MS;
}

/**
 * Bounded reinforcement from the brain's own usage history (P10).
 *
 * Confirmations outweigh recalls, because a recall is something an agent did and a
 * confirmation is something a human or an agent asserted. Both saturate, and both
 * decay with time since the last recall — so a memory that was hot last year does
 * not keep coasting on it, and no amount of retrieval can push a memory past the
 * ceiling its weight allows.
 */
export function reinforcementScore(
  features: RetrievalFeatures,
  now: Date
): number | null {
  const recalls = features.recallCount ?? 0;
  const confirmations = features.confirmationCount ?? 0;
  if (recalls <= 0 && confirmations <= 0) return null;

  const raw =
    0.35 * saturate(recalls, RECALL_SATURATION) +
    0.65 * saturate(confirmations, CONFIRMATION_SATURATION);

  const lastRecalled = toDate(features.lastRecalledAt);
  const decay = lastRecalled
    ? halfLifeDecay(ageInDays(lastRecalled, now), REINFORCEMENT_HALF_LIFE_DAYS)
    : 1;
  return clamp01(raw * decay);
}

/** Normalized match signals, or null where the leg abstained. */
function matchSignals(
  features: RetrievalFeatures,
  lexicalMax: number | null
): Record<MatchSignal, number | null> {
  const rank = features.lexicalRank;
  let lexical: number | null = null;
  if (rank != null && Number.isFinite(rank) && rank > 0) {
    const max = lexicalMax != null && lexicalMax > 0 ? lexicalMax : rank;
    lexical = clamp01(rank / max);
  }

  const cosine = features.semanticSimilarity;
  // Negative cosine means "unrelated", which is 0 here — not a negative vote.
  const semantic =
    cosine != null && Number.isFinite(cosine) ? clamp01(Math.max(0, cosine)) : null;

  const overlap = features.entityOverlap;
  const entity = overlap != null && Number.isFinite(overlap) ? clamp01(overlap) : null;

  const hops = features.graphHops;
  const graph =
    hops != null && Number.isFinite(hops) && hops >= 0
      ? clamp01(Math.pow(GRAPH_HOP_DECAY, hops))
      : null;

  const strength = features.relationshipStrength;
  const related =
    strength != null && Number.isFinite(strength) ? clamp01(strength) : null;

  return { lexical, semantic, entity, graph, related };
}

/** Normalized quality signals, or null where the memory carries no such datum. */
function qualitySignals(
  features: RetrievalFeatures,
  now: Date
): Record<QualitySignal, number | null> {
  const importance =
    features.importance != null && Number.isFinite(features.importance)
      ? clamp01(features.importance)
      : null;

  let confidence: number | null = null;
  if (features.confidence != null && Number.isFinite(features.confidence)) {
    const base = clamp01(features.confidence);
    const provenance = features.provenanceQuality;
    // Provenance quality tempers confidence rather than standing on its own: a
    // confident claim with no traceable source is worth less than the same claim
    // with one, but it is still the claim's confidence being scored.
    confidence =
      provenance != null && Number.isFinite(provenance)
        ? clamp01(0.7 * base + 0.3 * clamp01(provenance))
        : base;
  }

  const updatedAt = toDate(features.updatedAt);
  const recent = updatedAt
    ? halfLifeDecay(ageInDays(updatedAt, now), RECENCY_HALF_LIFE_DAYS)
    : null;

  return {
    important: importance,
    confidence,
    recent,
    reinforcement: reinforcementScore(features, now),
  };
}

/**
 * Weighted mean over the signals that voted, with the weights renormalized to the
 * voters. This is the whole reason a missing embedding provider costs nothing:
 * with `semantic` absent, the remaining weights simply divide the full pool.
 */
function poolScore(
  values: Partial<Record<ScoreSignal, number | null>>,
  weights: Readonly<Record<string, number>>
): { score: number; weightSum: number } {
  let weighted = 0;
  let weightSum = 0;
  for (const [signal, value] of Object.entries(values)) {
    if (value == null) continue;
    const weight = weights[signal] ?? 0;
    if (weight <= 0) continue;
    weighted += value * weight;
    weightSum += weight;
  }
  return { score: weightSum > 0 ? weighted / weightSum : 0, weightSum };
}

function validityMultiplier(state: RetrievalFeatures["validityState"]): number {
  if (!state) return VALIDITY_MULTIPLIER.active;
  // An unrecognized state is treated as active rather than silently demoted: a new
  // enum value must not quietly change every ranking before anyone notices.
  return VALIDITY_MULTIPLIER[state as ValidityState] ?? VALIDITY_MULTIPLIER.active;
}

/**
 * Score one candidate. Pure: no I/O, and no clock read unless `now` is omitted.
 *
 * `confidence` and `reinforcement` are scored but never reported as reasons —
 * {@link RETRIEVAL_REASONS} is a fixed vocabulary the MCP layer publishes. They
 * stay fully visible in {@link RetrievalScore.components}, so the arithmetic
 * remains auditable.
 */
export function scoreCandidate(
  features: RetrievalFeatures,
  options: ScoreOptions = {}
): RetrievalScore {
  const now = options.now ?? new Date();
  const match = matchSignals(features, options.lexicalMax ?? null);
  const quality = qualitySignals(features, now);

  const matchPool = poolScore(match, MATCH_WEIGHTS);
  const qualityPool = poolScore(quality, QUALITY_WEIGHTS);
  const multiplier = validityMultiplier(features.validityState);

  const raw = MATCH_SHARE * matchPool.score + QUALITY_SHARE * qualityPool.score;
  const score = clamp01(raw * multiplier);

  const components: ScoreComponent[] = [];
  const collect = (
    values: Partial<Record<ScoreSignal, number | null>>,
    weights: Readonly<Record<string, number>>,
    pool: "match" | "quality",
    share: number,
    weightSum: number
  ) => {
    for (const [signal, value] of Object.entries(values)) {
      if (value == null || weightSum <= 0) continue;
      const weight = weights[signal] ?? 0;
      if (weight <= 0) continue;
      components.push({
        signal: signal as ScoreSignal,
        pool,
        value: round6(value),
        weight,
        contribution: round6((share * value * weight * multiplier) / weightSum),
      });
    }
  };
  collect(match, MATCH_WEIGHTS, "match", MATCH_SHARE, matchPool.weightSum);
  collect(quality, QUALITY_WEIGHTS, "quality", QUALITY_SHARE, qualityPool.weightSum);

  components.sort(
    (a, b) => b.contribution - a.contribution || a.signal.localeCompare(b.signal)
  );

  const reasonVocabulary = new Set<string>(RETRIEVAL_REASONS);
  const whyMatched = components
    .filter(
      (component) =>
        reasonVocabulary.has(component.signal) &&
        component.contribution >= REASON_MIN_CONTRIBUTION
    )
    .slice(0, MAX_REASONS)
    .map((component) => component.signal as RetrievalReason);

  return {
    score: round6(score),
    matchScore: round6(matchPool.score),
    qualityScore: round6(qualityPool.score),
    validityMultiplier: multiplier,
    whyMatched,
    components,
  };
}

/** A candidate as the retrieval legs hand it over: an id plus raw features. */
export type RetrievalCandidate = {
  id: string;
  features: RetrievalFeatures;
};

export type RankedCandidate<T extends RetrievalCandidate> = T & {
  score: RetrievalScore;
  /** 1-based position after ranking, recorded in brain_retrieval_events. */
  rank: number;
};

/**
 * Rank a whole result set. THE entry point — it performs the set-relative
 * normalization that {@link scoreCandidate} cannot do alone (lexical rank has no
 * meaning outside its own result set).
 *
 * Ordering is total and deterministic: score, then match evidence, then id. Two
 * candidates that genuinely tie must not swap places between two identical
 * requests, or the context engine's "why was this one dropped" answer changes
 * without any input changing.
 */
export function rankCandidates<T extends RetrievalCandidate>(
  candidates: readonly T[],
  options: ScoreOptions = {}
): RankedCandidate<T>[] {
  const now = options.now ?? new Date();
  const lexicalMax = candidates.reduce((max, candidate) => {
    const rank = candidate.features.lexicalRank;
    return rank != null && Number.isFinite(rank) && rank > max ? rank : max;
  }, 0);

  const scored = candidates.map((candidate) => ({
    ...candidate,
    score: scoreCandidate(candidate.features, {
      now,
      lexicalMax: lexicalMax > 0 ? lexicalMax : null,
    }),
    rank: 0,
  }));

  scored.sort(
    (a, b) =>
      b.score.score - a.score.score ||
      b.score.matchScore - a.score.matchScore ||
      a.id.localeCompare(b.id)
  );
  scored.forEach((candidate, index) => {
    candidate.rank = index + 1;
  });
  return scored;
}

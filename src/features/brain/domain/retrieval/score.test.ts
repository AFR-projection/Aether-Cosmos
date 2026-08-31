import { describe, it, expect } from "vitest";
import {
  MATCH_SHARE,
  MAX_REASONS,
  QUALITY_SHARE,
  RETRIEVAL_REASONS,
  VALIDITY_MULTIPLIER,
  halfLifeDecay,
  rankCandidates,
  reinforcementScore,
  saturate,
  scoreCandidate,
  type RetrievalFeatures,
} from "./score";

/**
 * The scorer is the one place where "intelligent retrieval" is either real or
 * cosmetic, so these tests are about invariants rather than magic numbers: bounded
 * output, abstention instead of zero votes, quality never faking relevance,
 * superseded knowledge ranking below its replacement, and a total deterministic
 * order.
 */

const NOW = new Date("2026-08-22T00:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

function score(features: RetrievalFeatures, lexicalMax?: number) {
  return scoreCandidate(features, { now: NOW, lexicalMax: lexicalMax ?? null });
}

describe("scoreCandidate — bounds", () => {
  it("stays inside [0, 1] for absurd inputs", () => {
    const wild = score({
      lexicalRank: 1e9,
      semanticSimilarity: 42,
      entityOverlap: 99,
      graphHops: -5,
      relationshipStrength: 1e6,
      importance: 5,
      confidence: 5,
      provenanceQuality: 5,
      updatedAt: new Date("2099-01-01T00:00:00.000Z"),
      recallCount: 1e6,
      confirmationCount: 1e6,
    });
    expect(wild.score).toBeGreaterThanOrEqual(0);
    expect(wild.score).toBeLessThanOrEqual(1);
    expect(wild.matchScore).toBeLessThanOrEqual(1);
    expect(wild.qualityScore).toBeLessThanOrEqual(1);
  });

  it("returns 0 with no signals at all", () => {
    const empty = score({});
    expect(empty.score).toBe(0);
    expect(empty.components).toEqual([]);
    expect(empty.whyMatched).toEqual([]);
  });

  it("is NaN-safe", () => {
    const bad = score({
      lexicalRank: Number.NaN,
      semanticSimilarity: Number.NaN,
      importance: Number.NaN,
      confidence: Number.NaN,
      updatedAt: "not a date",
    });
    expect(Number.isFinite(bad.score)).toBe(true);
    expect(bad.components).toEqual([]);
  });
});

describe("a missing signal abstains — it does not vote zero", () => {
  const base: RetrievalFeatures = {
    lexicalRank: 0.4,
    importance: 0.5,
    confidence: 0.8,
    updatedAt: daysAgo(10),
  };

  it("scores identically with the semantic leg absent as with it never existing", () => {
    const withoutProvider = score(base);
    const withNullSimilarity = score({ ...base, semanticSimilarity: null });
    expect(withNullSimilarity).toEqual(withoutProvider);
  });

  it("scores LOWER when semantic similarity is genuinely zero", () => {
    // This is the distinction that keeps a brain with no embedding provider from
    // silently ranking worse than one with a model: "no opinion" ≠ "no similarity".
    expect(score({ ...base, semanticSimilarity: 0 }).score).toBeLessThan(
      score(base).score
    );
  });

  it("preserves the ordering of two memories when neither has embeddings", () => {
    const strong = score({ ...base, lexicalRank: 0.9 }, 0.9);
    const weak = score({ ...base, lexicalRank: 0.1 }, 0.9);
    expect(strong.score).toBeGreaterThan(weak.score);
  });
});

describe("quality cannot manufacture relevance", () => {
  it("caps a candidate with no match evidence at the quality share", () => {
    const perfectButUnmatched = score({
      importance: 1,
      confidence: 1,
      updatedAt: NOW,
      recallCount: 100,
      confirmationCount: 100,
    });
    expect(perfectButUnmatched.matchScore).toBe(0);
    expect(perfectButUnmatched.score).toBeLessThanOrEqual(QUALITY_SHARE);
  });

  it("lets a weak lexical match outrank a perfect unmatched memory", () => {
    const matched = score({ lexicalRank: 1, importance: 0, confidence: 0 });
    const unmatched = score({
      importance: 1,
      confidence: 1,
      updatedAt: NOW,
      confirmationCount: 50,
    });
    expect(matched.score).toBeGreaterThan(unmatched.score);
    expect(matched.score).toBeGreaterThanOrEqual(MATCH_SHARE * 0.5);
  });
});

describe("validity affects ranking without hiding knowledge (P5)", () => {
  const features: RetrievalFeatures = {
    lexicalRank: 0.8,
    importance: 0.6,
    confidence: 0.9,
    updatedAt: daysAgo(5),
  };

  it("demotes superseded and retracted memories below the active one", () => {
    const active = score({ ...features, validityState: "active" }).score;
    const stale = score({ ...features, validityState: "stale" }).score;
    const superseded = score({ ...features, validityState: "superseded" }).score;
    const retracted = score({ ...features, validityState: "retracted" }).score;
    expect(stale).toBeLessThan(active);
    expect(superseded).toBeLessThan(stale);
    expect(retracted).toBeLessThan(superseded);
  });

  it("never zeroes a demoted memory, so provenance can still reach it", () => {
    for (const state of Object.keys(VALIDITY_MULTIPLIER)) {
      expect(score({ ...features, validityState: state }).score).toBeGreaterThan(0);
    }
  });

  it("treats an unrecognized validity state as active instead of demoting it", () => {
    // A future enum value must not silently rewrite every ranking.
    expect(score({ ...features, validityState: "brand_new_state" }).score).toBe(
      score({ ...features, validityState: "active" }).score
    );
  });
});

describe("explainability", () => {
  const rich = score({
    lexicalRank: 0.9,
    semanticSimilarity: 0.7,
    entityOverlap: 0.5,
    graphHops: 2,
    relationshipStrength: 0.4,
    importance: 0.8,
    confidence: 0.9,
    updatedAt: daysAgo(3),
    recallCount: 4,
    confirmationCount: 2,
    lastRecalledAt: daysAgo(1),
  });

  it("reports only the published reason vocabulary", () => {
    for (const reason of rich.whyMatched) {
      expect(RETRIEVAL_REASONS).toContain(reason);
    }
  });

  it("caps the reason list and orders it by contribution", () => {
    expect(rich.whyMatched.length).toBeGreaterThan(0);
    expect(rich.whyMatched.length).toBeLessThanOrEqual(MAX_REASONS);
    expect(rich.whyMatched[0]).toBe("lexical");
  });

  it("accounts for the whole score in its components", () => {
    // Every point of the score is attributable to a named signal — no residue, no
    // unexplained bonus.
    const total = rich.components.reduce((sum, part) => sum + part.contribution, 0);
    expect(total).toBeCloseTo(rich.score, 5);
  });

  it("keeps confidence and reinforcement auditable even though they are not reasons", () => {
    const signals = rich.components.map((part) => part.signal);
    expect(signals).toContain("confidence");
    expect(signals).toContain("reinforcement");
    expect(rich.whyMatched).not.toContain("confidence" as never);
    expect(rich.whyMatched).not.toContain("reinforcement" as never);
  });

  it("omits a signal that did not vote instead of reporting it as 0", () => {
    const lexicalOnly = score({ lexicalRank: 0.5 });
    expect(lexicalOnly.components.map((part) => part.signal)).toEqual(["lexical"]);
  });
});

describe("determinism", () => {
  const features: RetrievalFeatures = {
    lexicalRank: 0.6,
    semanticSimilarity: 0.5,
    importance: 0.4,
    confidence: 0.7,
    updatedAt: daysAgo(12),
    recallCount: 3,
    lastRecalledAt: daysAgo(2),
  };

  it("produces byte-identical results for identical inputs", () => {
    expect(score(features)).toEqual(score(features));
  });

  it("accepts an ISO string exactly as it accepts a Date", () => {
    expect(score({ ...features, updatedAt: daysAgo(12).toISOString() })).toEqual(
      score(features)
    );
  });
});

describe("decay and saturation are bounded (P10: no runaway feedback)", () => {
  it("halves at the half-life and never exceeds 1", () => {
    expect(halfLifeDecay(0, 45)).toBe(1);
    expect(halfLifeDecay(45, 45)).toBeCloseTo(0.5, 6);
    expect(halfLifeDecay(90, 45)).toBeCloseTo(0.25, 6);
    // Clock skew must not become a ranking advantage.
    expect(halfLifeDecay(-100, 45)).toBe(1);
  });

  it("saturates counts instead of letting them grow without bound", () => {
    expect(saturate(0, 20)).toBe(0);
    expect(saturate(20, 20)).toBeCloseTo(1, 6);
    expect(saturate(1_000_000, 20)).toBe(1);
    expect(saturate(5, 20)).toBeGreaterThan(saturate(2, 20));
  });

  it("cannot be pushed past its ceiling by retrieval volume", () => {
    const hammered = reinforcementScore(
      { recallCount: 10_000_000, confirmationCount: 10_000_000, lastRecalledAt: NOW },
      NOW
    );
    expect(hammered).toBeLessThanOrEqual(1);
    expect(hammered).toBeCloseTo(1, 6);
  });

  it("decays reinforcement for a memory nobody has touched in a year", () => {
    const fresh = reinforcementScore(
      { recallCount: 10, confirmationCount: 3, lastRecalledAt: NOW },
      NOW
    );
    const cold = reinforcementScore(
      { recallCount: 10, confirmationCount: 3, lastRecalledAt: daysAgo(365) },
      NOW
    );
    expect(cold!).toBeLessThan(fresh! * 0.2);
  });

  it("abstains when the memory has never been recalled or confirmed", () => {
    expect(reinforcementScore({}, NOW)).toBeNull();
    expect(reinforcementScore({ recallCount: 0, confirmationCount: 0 }, NOW)).toBeNull();
  });

  it("weighs a confirmation more heavily than a recall", () => {
    const confirmed = reinforcementScore({ confirmationCount: 3 }, NOW)!;
    const recalled = reinforcementScore({ recallCount: 3 }, NOW)!;
    expect(confirmed).toBeGreaterThan(recalled);
  });
});

describe("graph proximity", () => {
  it("decays with every hop and never beats a direct match", () => {
    const hops = [0, 1, 2, 3, 4].map((h) => score({ graphHops: h }).score);
    for (let i = 1; i < hops.length; i += 1) {
      expect(hops[i]).toBeLessThan(hops[i - 1]);
    }
    expect(hops[1]).toBeLessThan(score({ lexicalRank: 1 }).score);
  });
});

describe("provenance tempers confidence", () => {
  it("ranks a confident claim with no traceable source below a sourced one", () => {
    const sourced = score({ lexicalRank: 1, confidence: 0.9, provenanceQuality: 1 });
    const unsourced = score({ lexicalRank: 1, confidence: 0.9, provenanceQuality: 0 });
    expect(sourced.score).toBeGreaterThan(unsourced.score);
  });

  it("leaves confidence untouched when provenance quality is unknown", () => {
    expect(score({ lexicalRank: 1, confidence: 0.9 }).qualityScore).toBe(
      score({ lexicalRank: 1, confidence: 0.9, provenanceQuality: null }).qualityScore
    );
  });
});

describe("rankCandidates", () => {
  const candidates = [
    { id: "c", features: { lexicalRank: 0.02, importance: 0.1 } },
    { id: "a", features: { lexicalRank: 2.5, importance: 0.9, updatedAt: daysAgo(1) } },
    { id: "b", features: { lexicalRank: 0.5, importance: 0.5, updatedAt: daysAgo(30) } },
  ];

  it("normalizes lexical rank against the strongest hit in the set", () => {
    const ranked = rankCandidates(candidates, { now: NOW });
    const best = ranked.find((item) => item.id === "a")!;
    const lexical = best.score.components.find((part) => part.signal === "lexical")!;
    expect(lexical.value).toBe(1);
  });

  it("orders by score and assigns 1-based ranks", () => {
    const ranked = rankCandidates(candidates, { now: NOW });
    expect(ranked.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(ranked.map((item) => item.rank)).toEqual([1, 2, 3]);
  });

  it("breaks exact ties by id, so two identical requests never disagree", () => {
    const tied = [
      { id: "zzz", features: { lexicalRank: 1, importance: 0.5 } },
      { id: "aaa", features: { lexicalRank: 1, importance: 0.5 } },
      { id: "mmm", features: { lexicalRank: 1, importance: 0.5 } },
    ];
    expect(rankCandidates(tied, { now: NOW }).map((item) => item.id)).toEqual([
      "aaa",
      "mmm",
      "zzz",
    ]);
    expect(rankCandidates([...tied].reverse(), { now: NOW }).map((i) => i.id)).toEqual([
      "aaa",
      "mmm",
      "zzz",
    ]);
  });

  it("does not mutate the caller's array or its candidates", () => {
    const input = [...candidates];
    rankCandidates(input, { now: NOW });
    expect(input.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(input[0]).not.toHaveProperty("score");
  });

  it("returns an empty ranking for an empty set", () => {
    expect(rankCandidates([], { now: NOW })).toEqual([]);
  });

  it("puts a superseded memory below the memory that replaced it", () => {
    const ranked = rankCandidates(
      [
        {
          id: "old",
          features: {
            lexicalRank: 1,
            importance: 0.9,
            confidence: 1,
            updatedAt: daysAgo(2),
            validityState: "superseded",
          },
        },
        {
          id: "new",
          features: {
            lexicalRank: 0.6,
            importance: 0.5,
            confidence: 0.8,
            updatedAt: daysAgo(1),
          },
        },
      ],
      { now: NOW }
    );
    expect(ranked[0].id).toBe("new");
  });
});

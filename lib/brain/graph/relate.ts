/**
 * Derived relationships between memories.
 *
 * The brain has two *explicit* relationship tables — memory_links and
 * brain_relationships — and they are always the strongest edges in the graph.
 * Nothing in the app writes to them automatically, though, so a brain that has
 * never used the link API graphs as isolated dots. This module fills that gap by
 * deriving edges from signals the data already carries, and only from those:
 *
 *   1. shared entity mentions  (both memories link to the same entity)
 *   2. shared tags             (a deliberate act by the user, so it counts)
 *   3. lexical similarity      (TF-IDF cosine over title + content)
 *   4. same project            (a booster only — never enough on its own)
 *
 * There is no embedding column and no pgvector in this schema, so tier 3 is
 * lexical, not vector-semantic. It is deliberately conservative: a pair needs at
 * least two *distinctive* shared terms before similarity counts at all, which is
 * what stops "both mention Telegram" from becoming an edge.
 *
 * Sparseness is the point. Every candidate is scored, then pruned three ways —
 * a weight floor, a per-node top-K, and a hard degree ceiling — so the result is
 * a knowledge network with hubs and clusters, never a complete graph. Orphans are
 * left alone: a memory with nothing in common with anything is a real finding.
 *
 * Pure and synchronous: no DB, no I/O, so tests/brain-graph-relations.test.ts can
 * pin the behaviour exactly.
 */

export type RelateMemory = {
  id: string;
  title: string;
  /** Bounded body text. Server-side only — never put on the wire. */
  content: string;
  tags: string[];
  projectId: string | null;
  /** Entity ids this memory explicitly links to, from memory_links. */
  entityIds: string[];
};

export type DerivedRelation = "semantic" | "tag" | "entity" | "project";

export type DerivedEdge = {
  source: string;
  target: string;
  relation: DerivedRelation;
  /** 0..1. Explicit rows outrank every derived edge by construction. */
  weight: number;
  /** Short human reason, shown in the detail card: why this edge exists. */
  reason: string;
};

export type RelateResult = {
  edges: DerivedEdge[];
  /** Pairs actually scored. Diagnostics only. */
  candidates: number;
};

// ── tuning ──────────────────────────────────────────────────────────────────
// Chosen against the real account data (17 memories, 151–906 chars of content,
// 39 tags) and re-checked against synthetic graphs of 200 and 1200 memories in
// tests/brain-graph-relations.test.ts. They are graph-shape controls, not magic
// numbers: raise MIN_WEIGHT for a sparser graph, raise NEIGHBOURS for a denser one.

/** Cosine at which the lexical signal is considered maxed out. */
const SEMANTIC_FULL = 0.42;
/** Below this cosine the lexical tier cannot open an edge on its own. */
const SEMANTIC_MIN = 0.14;
/** Shared terms this distinctive count towards the "two shared terms" rule. */
const DISTINCTIVE_DF_RATIO = 0.5;
/**
 * One shared tag opens an edge only when the tag is rare: rare in proportion to
 * the brain, with a floor so a 17-memory brain still has a usable notion of rare.
 */
const RARE_TAG_DF_RATIO = 0.05;
const RARE_TAG_DF_ABS = 4;
/**
 * Shared tag IDF at which the tag tier is maxed out — roughly two moderately
 * shared tags, or one very rare one. Measured on the real data: tags there are
 * mostly unique per memory, so a *ratio* (Jaccard, overlap) scores a genuinely
 * meaningful shared tag at ~0.12 and the whole tier never opens an edge. What
 * makes a shared tag informative is the rarity of the tag itself, not how many
 * other tags the two memories happen to carry, so the shared IDF mass is scored
 * directly and saturated.
 */
const TAG_IDF_FULL = 3.4;
/** Tier ceilings. Their sum is capped below 1 so explicit edges always win. */
const SEMANTIC_MAX = 0.7;
const TAG_MAX = 0.55;
const ENTITY_MAX = 0.6;
const PROJECT_BONUS = 0.15;
const DERIVED_MAX = 0.95;

export const RELATE_DEFAULTS = {
  /**
   * Strength floor. The tier gates below already guarantee ~0.23 for anything they
   * let through, so at this value the *gates* decide what is a relationship and the
   * floor is the knob for trimming further: on the real 17-memory brain 0.2 keeps
   * 14 edges, 0.25 keeps 13, 0.3 keeps 12.
   */
  minWeight: 0.2,
  /** Top-K per node. An edge survives if it is in *either* endpoint's top K. */
  neighbours: 6,
  /** Hard ceiling per node, so one busy memory cannot become a hairball. */
  maxDegree: 12,
  /** Global ceiling, sized to stay well inside the snapshot's edge budget. */
  maxEdges: 4000,
};

export type RelateOptions = Partial<typeof RELATE_DEFAULTS>;

/** A term in this many documents is a label, not a link; skip its postings. */
const POSTING_MAX = 48;
/** Absolute cap on scored pairs, so a pathological vocabulary cannot stall a request. */
const CANDIDATE_MAX = 250_000;
/** Longest reason string put on the wire. */
const REASON_MAX = 90;

// ── tokenizing ──────────────────────────────────────────────────────────────
// The memories in this account mix Indonesian and English in the same sentence,
// so an English-only list (like the one in consolidation-service.ts) would leave
// "yang", "untuk", "adalah" as high-frequency noise terms. Both languages are
// listed here. There is no stemmer: Indonesian affixes ("meng-", "-kan", "-nya")
// would need a real morphological analyser, and naive suffix stripping conflates
// unrelated words — a false edge is worse than a missed one.
//
// Exported because entity extraction (lib/brain/enrich/extract.ts) must reject the
// exact same words. Two lists would drift, and a drifted list is how "Yang" ends
// up as a person node in the graph.

export const STOP_WORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "so", "because",
  "is", "are", "was", "were", "be", "been", "being", "am", "will", "would",
  "can", "could", "should", "shall", "may", "might", "must", "do", "does",
  "did", "done", "has", "have", "had", "to", "of", "in", "on", "at", "by",
  "for", "with", "from", "into", "onto", "about", "over", "under", "after",
  "before", "between", "during", "while", "when", "where", "which", "who",
  "whom", "whose", "what", "why", "how", "this", "that", "these", "those",
  "there", "here", "it", "its", "his", "her", "their", "our", "your", "my",
  "we", "you", "they", "she", "he", "me", "him", "them", "us", "not", "no",
  "yes", "all", "any", "both", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "very", "just", "also", "too", "as", "up",
  "out", "off", "down", "again", "once", "use", "used", "uses", "using", "get",
  "got", "make", "made", "like", "want", "need", "know", "see", "say", "said",
  "one", "two", "new", "now", "via", "per", "etc",
  // Indonesian
  "yang", "dan", "atau", "tapi", "tetapi", "kalau", "jika", "maka", "karena",
  "sebab", "adalah", "ialah", "ini", "itu", "untuk", "dengan", "pada", "dari",
  "ke", "di", "dalam", "atas", "bawah", "oleh", "akan", "sudah", "telah",
  "belum", "sedang", "masih", "juga", "saja", "hanya", "sangat", "lebih",
  "paling", "tidak", "bukan", "jangan", "ada", "tanpa", "bisa", "dapat",
  "harus", "boleh", "mau", "ingin", "perlu", "saya", "aku", "kamu", "anda",
  "dia", "mereka", "kita", "kami", "nya", "aja", "gak", "ga", "udah", "biar",
  "supaya", "agar", "kalo", "bikin", "buat", "pakai", "pake", "sama", "lagi",
  "banget", "kayak", "seperti", "yaitu", "yakni", "hal", "cara", "orang",
  "waktu", "saat", "setelah", "sebelum", "antara", "setiap", "semua", "beberapa",
  "bagi", "hingga", "sampai", "serta", "sebagai", "tersebut", "dulu", "terus",
]);

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;
const MIN_TOKEN = 3;
const MAX_TOKEN = 24;
/** Content is already bounded upstream; this bounds the term count too. */
const MAX_TOKENS_PER_DOC = 400;

/** Term frequencies for one memory. Numbers, stopwords and stubs are dropped. */
function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) return counts;
  const parts = text.toLowerCase().split(TOKEN_SPLIT);
  for (const part of parts) {
    if (part.length < MIN_TOKEN || part.length > MAX_TOKEN) continue;
    if (STOP_WORDS.has(part)) continue;
    // A bare number carries no topical meaning; "gpt4" and "v2" still pass.
    if (!/\p{L}/u.test(part)) continue;
    counts.set(part, (counts.get(part) ?? 0) + 1);
    if (counts.size >= MAX_TOKENS_PER_DOC) break;
  }
  return counts;
}

/** A title term is a stronger signal than a body term, as in the FTS weighting. */
const TITLE_WEIGHT = 3;

type Doc = {
  id: string;
  /** Term -> L2-normalised TF-IDF weight, so cosine is a plain dot product. */
  vector: Map<string, number>;
  /** Terms rare enough to mean something. Drives the two-shared-terms rule. */
  distinctive: Set<string>;
  tags: string[];
  entityIds: string[];
  projectId: string | null;
};

/** ln(1 + N/df): high for rare terms, near zero for terms in every memory. */
function idfOf(total: number, df: number): number {
  return Math.log(1 + total / Math.max(1, df));
}

function buildDocs(memories: RelateMemory[]): { docs: Doc[]; termDf: Map<string, number> } {
  const raw: Map<string, number>[] = [];
  const termDf = new Map<string, number>();

  for (const memory of memories) {
    const counts = termCounts(memory.title);
    for (const [term, count] of counts) counts.set(term, count * TITLE_WEIGHT);
    for (const [term, count] of termCounts(memory.content)) {
      counts.set(term, (counts.get(term) ?? 0) + count);
    }
    raw.push(counts);
    for (const term of counts.keys()) termDf.set(term, (termDf.get(term) ?? 0) + 1);
  }

  const total = memories.length;
  const distinctiveMax = Math.max(2, Math.floor(total * DISTINCTIVE_DF_RATIO));
  const docs: Doc[] = memories.map((memory, index) => {
    const counts = raw[index];
    const vector = new Map<string, number>();
    const distinctive = new Set<string>();
    let norm = 0;
    for (const [term, count] of counts) {
      const df = termDf.get(term) ?? 1;
      // A term unique to one memory cannot connect it to anything, but it still
      // belongs in the vector: dropping it would inflate the cosine of the rest.
      const weight = (1 + Math.log(count)) * idfOf(total, df);
      if (weight <= 0) continue;
      vector.set(term, weight);
      norm += weight * weight;
      if (df >= 2 && df <= distinctiveMax) distinctive.add(term);
    }
    norm = Math.sqrt(norm);
    if (norm > 0) for (const [term, weight] of vector) vector.set(term, weight / norm);
    return {
      id: memory.id,
      vector,
      distinctive,
      tags: memory.tags,
      entityIds: memory.entityIds,
      projectId: memory.projectId,
    };
  });

  return { docs, termDf };
}

/** Dot product of two L2-normalised vectors, walked over the smaller one. */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let sum = 0;
  for (const [term, weight] of small) {
    const other = large.get(term);
    if (other !== undefined) sum += weight * other;
  }
  return sum;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value > 1 ? 1 : value;
}

// ── candidate generation ────────────────────────────────────────────────────
// Scoring every pair is O(n²): 1200 memories would be 719k pairs of map walks on
// every snapshot. Instead each shared signal is an inverted index, and only pairs
// that co-occur in at least one posting list are ever scored. A pair with nothing
// in common is not "rejected" — it is never looked at, which is what keeps the
// derivation linear in the number of real overlaps.
//
// Postings longer than POSTING_MAX are skipped: a term or tag on that many
// memories is a label for the whole brain and would pair everything with
// everything. Projects are never a posting list at all, for the same reason —
// they would make a clique out of every project.

function invert(count: number, postingsOf: (index: number) => Iterable<string>) {
  const index = new Map<string, number[]>();
  for (let i = 0; i < count; i += 1) {
    for (const key of postingsOf(i)) {
      const bucket = index.get(key);
      if (bucket) bucket.push(i);
      else index.set(key, [i]);
    }
  }
  return index;
}

/** Pairs to score, keyed as `a * count + b` with a < b so each pair appears once. */
function collectCandidates(docs: Doc[], termDf: Map<string, number>): Set<number> {
  const count = docs.length;
  const pairs = new Set<number>();
  const add = (a: number, b: number) => {
    if (pairs.size >= CANDIDATE_MAX) return false;
    pairs.add(a * count + b);
    return true;
  };

  const indexes = [
    invert(count, (i) => docs[i].tags),
    invert(count, (i) => docs[i].entityIds),
    // Only distinctive terms open candidates. Common vocabulary can still raise a
    // pair's cosine once it is a candidate; it just cannot nominate one.
    invert(count, (i) => {
      const terms: string[] = [];
      for (const term of docs[i].distinctive) {
        if ((termDf.get(term) ?? 0) <= POSTING_MAX) terms.push(term);
      }
      return terms;
    }),
  ];

  for (const index of indexes) {
    for (const bucket of index.values()) {
      if (bucket.length < 2 || bucket.length > POSTING_MAX) continue;
      for (let x = 0; x < bucket.length; x += 1) {
        for (let y = x + 1; y < bucket.length; y += 1) {
          if (!add(bucket[x], bucket[y])) return pairs;
        }
      }
    }
  }
  return pairs;
}

// ── scoring ─────────────────────────────────────────────────────────────────

/** Shared entities needed before the entity tier is considered maxed out. */
const ENTITY_FULL = 2;

type Scored = {
  a: number;
  b: number;
  weight: number;
  relation: DerivedRelation;
  reason: string;
};

/** Intersection of two small string arrays, as a list (order follows `a`). */
function shared(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return [];
  const other = new Set(b);
  const both: string[] = [];
  for (const value of a) if (other.has(value)) both.push(value);
  return both;
}

/** Rare tags first, so the reason names the tag that actually carries the edge. */
function byRarity(tags: string[], df: Map<string, number>): string[] {
  return [...tags].sort((x, y) => (df.get(x) ?? 0) - (df.get(y) ?? 0));
}

function joinReason(parts: string[]): string {
  const text = parts.filter(Boolean).join(" · ");
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1).trimEnd()}…` : text;
}

/**
 * Scores one candidate pair, or returns null when no tier opens an edge.
 *
 * Each tier has its own gate, and at least one gate must pass. The gates are the
 * whole anti-noise mechanism: without them a single shared word or a tag used on
 * half the brain would be enough, which is exactly the hairball to avoid.
 */
function scorePair(
  a: number,
  b: number,
  docs: Doc[],
  tagDf: Map<string, number>,
  total: number
): Scored | null {
  const left = docs[a];
  const right = docs[b];

  // Entities: an explicit co-mention of the same thing. The strongest derived signal.
  const sharedEntities = shared(left.entityIds, right.entityIds);
  const entityNorm = clamp01(sharedEntities.length / ENTITY_FULL);

  // Tags: deliberate user classification. One tag is enough only when it is rare.
  const sharedTags = byRarity(shared(left.tags, right.tags), tagDf);
  let tagWeight = 0;
  let rareTag = false;
  if (sharedTags.length > 0) {
    let sharedIdf = 0;
    for (const tag of sharedTags) sharedIdf += idfOf(total, tagDf.get(tag) ?? 1);
    tagWeight = clamp01(sharedIdf / TAG_IDF_FULL);
    const rareCutoff = Math.max(
      RARE_TAG_DF_ABS,
      Math.min(POSTING_MAX, Math.floor(total * RARE_TAG_DF_RATIO))
    );
    rareTag = (tagDf.get(sharedTags[0]) ?? 0) <= rareCutoff;
  }
  const tagGate = sharedTags.length >= 2 || rareTag;

  // Lexical similarity: the stand-in for the embeddings this schema does not have.
  // Two distinctive shared terms are required, so one coincidental word is inert.
  const sharedTerms: string[] = [];
  for (const term of left.distinctive) {
    if (right.distinctive.has(term)) sharedTerms.push(term);
    if (sharedTerms.length >= 6) break;
  }
  const similarity = sharedTerms.length > 0 ? cosine(left.vector, right.vector) : 0;
  const semanticGate = similarity >= SEMANTIC_MIN && sharedTerms.length >= 2;
  const semanticNorm = semanticGate ? clamp01(similarity / SEMANTIC_FULL) : 0;

  if (!semanticGate && !tagGate && sharedEntities.length === 0) return null;

  const sameProject =
    left.projectId !== null && right.projectId !== null && left.projectId === right.projectId;

  const contributions: { relation: DerivedRelation; value: number; reason: string }[] = [
    {
      relation: "entity",
      value: ENTITY_MAX * entityNorm,
      reason:
        sharedEntities.length > 1
          ? `Mentions ${sharedEntities.length} of the same entities`
          : "Mentions the same entity",
    },
    {
      relation: "tag",
      value: tagGate ? TAG_MAX * tagWeight : 0,
      reason: `Shared tags: ${sharedTags.slice(0, 3).join(", ")}`,
    },
    {
      relation: "semantic",
      value: SEMANTIC_MAX * semanticNorm,
      reason: `Shared terms: ${sharedTerms.slice(0, 4).join(", ")}`,
    },
    {
      relation: "project",
      value: sameProject ? PROJECT_BONUS : 0,
      reason: "Same project",
    },
  ];

  let weight = 0;
  for (const part of contributions) weight += part.value;
  if (weight <= 0) return null;
  weight = Math.min(DERIVED_MAX, weight);

  const ranked = contributions.filter((part) => part.value > 0).sort((x, y) => y.value - x.value);
  return {
    a,
    b,
    weight,
    relation: ranked[0].relation,
    reason: joinReason(ranked.slice(0, 2).map((part) => part.reason)),
  };
}

// ── pruning ─────────────────────────────────────────────────────────────────

/**
 * Derives the relationship set for one brain's memories.
 *
 * Pruning is two greedy passes over the candidates in descending weight — first
 * connectivity, then densification — which keeps the result deterministic and
 * keeps the global cap from turning a budget shortfall into a false orphan. The
 * per-pass rules are documented where they run.
 */
export function relateMemories(memories: RelateMemory[], options: RelateOptions = {}): RelateResult {
  const { minWeight, neighbours, maxDegree, maxEdges } = { ...RELATE_DEFAULTS, ...options };
  if (memories.length < 2) return { edges: [], candidates: 0 };

  const { docs, termDf } = buildDocs(memories);
  const total = docs.length;

  const tagDf = new Map<string, number>();
  for (const doc of docs) {
    // A memory carrying the same tag twice must not count twice.
    for (const tag of new Set(doc.tags)) tagDf.set(tag, (tagDf.get(tag) ?? 0) + 1);
  }

  const pairs = collectCandidates(docs, termDf);
  const scored: Scored[] = [];
  for (const key of pairs) {
    const a = Math.floor(key / total);
    const b = key % total;
    const result = scorePair(a, b, docs, tagDf, total);
    if (result && result.weight >= minWeight) scored.push(result);
  }

  // Descending weight, then by node index, so equal-weight edges resolve the same
  // way on every run: the graph must not reshuffle itself between two snapshots.
  scored.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);

  const degree = new Int32Array(total);
  const accepted: Scored[] = [];
  const room = (candidate: Scored) =>
    degree[candidate.a] < maxDegree && degree[candidate.b] < maxDegree;
  const take = (candidate: Scored) => {
    degree[candidate.a] += 1;
    degree[candidate.b] += 1;
    accepted.push(candidate);
  };

  // Round one is connectivity: every memory that has *any* real relationship gets
  // its strongest one before any memory gets a second. Without this the global cap
  // truncates in weight order and starves whole clusters at the tail — nodes would
  // then look like orphans because the budget ran out, not because the data says so,
  // and an orphan has to mean something.
  const used = new Uint8Array(scored.length);
  for (let i = 0; i < scored.length && accepted.length < maxEdges; i += 1) {
    const candidate = scored[i];
    if (degree[candidate.a] > 0 && degree[candidate.b] > 0) continue;
    if (!room(candidate)) continue;
    used[i] = 1;
    take(candidate);
  }

  // Round two densifies: an edge survives while *either* endpoint still has room in
  // its top K. The union rule is what lets a real hub grow past K — an intersection
  // rule erases hubs, because the hub's own list fills first and every spoke then
  // loses its only connection. The hard ceiling still applies above the K budget.
  for (let i = 0; i < scored.length && accepted.length < maxEdges; i += 1) {
    if (used[i]) continue;
    const candidate = scored[i];
    if (!room(candidate)) continue;
    if (degree[candidate.a] >= neighbours && degree[candidate.b] >= neighbours) continue;
    take(candidate);
  }

  accepted.sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b);

  const edges: DerivedEdge[] = accepted.map((candidate) => {
    // Canonical id order, so the edge's identity does not depend on which memory
    // the query happened to return first.
    const first = docs[candidate.a].id;
    const second = docs[candidate.b].id;
    const forward = first < second;
    return {
      source: forward ? first : second,
      target: forward ? second : first,
      relation: candidate.relation,
      weight: Math.round(candidate.weight * 1000) / 1000,
      reason: candidate.reason,
    };
  });

  return { edges, candidates: pairs.size };
}

// ── PHASE 2: Single-seed scoring ───────────────────────────────────────────

/**
 * PHASE 2: Structured evidence for derived edges, bounded and safe for agents.
 * Never contains full memory content — only signal metadata.
 */
export type EdgeEvidence = {
  signals: {
    semantic?: { similarity: number; sharedTerms: string[] };
    tag?: { sharedTags: string[]; rare: boolean };
    entity?: { sharedEntityIds: string[] };
    project?: boolean;
  };
  signalFamilyCount: number;
};

/**
 * PHASE 2: Scored edge with full provenance for persistence layer.
 */
export type ScoredEdgeWithEvidence = {
  memoryA: string;
  memoryB: string;
  relation: DerivedRelation;
  weight: number;
  reason: string;
  evidence: EdgeEvidence;
};

/**
 * PHASE 2: Score one seed memory against a bounded candidate set.
 *
 * Determinism guarantee: for the SAME (seed, candidates) inputs, the output is
 * byte-stable across runs — the final sort is total-ordered (weight desc, then
 * memoryB), and every score is a pure function of the inputs.
 *
 * NOT equal to a full-brain run. IDF/DF — both term (buildDocs) and tag — and the
 * document `total` are computed LOCALLY over `[seed, ...candidates]`, never over the
 * whole brain. So the same pair can come out with a different weight here than a
 * full-brain relateMemories() would give it, and can even clear or miss its gate
 * differently: fewer documents means different rarity, which moves the cosine, the
 * distinctive-term set, and the tag IDF. This is intentional — candidates are already
 * pre-filtered and bounded upstream (relate-candidates.ts), and derived edges are a
 * bounded suggestion layer, so local DF is the correct, cheaper contract. Do NOT
 * "restore parity" by threading global DF in without a policy decision: it rewrites
 * every derived edge weight in the brain.
 *
 * What IS shared with relateMemories is the scoring CODE — scorePair(), buildDocs(),
 * the gates — so the two entry points apply one formula, not two. They agree on how
 * to score given identical inputs; they are fed different inputs on purpose.
 *
 * Pruning is NOT applied here — that happens in the persistence layer after
 * candidates from all probes are merged. This function returns every pair that
 * passes the signal gates + minWeight threshold.
 */
export function relateOne(
  seed: RelateMemory,
  candidates: RelateMemory[],
  options: RelateOptions = {}
): ScoredEdgeWithEvidence[] {
  const { minWeight } = { ...RELATE_DEFAULTS, ...options };

  if (candidates.length === 0) return [];

  // Build docs for seed + candidates. Only `docs` is needed: candidate nomination
  // (the one consumer of `termDf`) already happened upstream in relate-candidates.
  const memories = [seed, ...candidates];
  const { docs } = buildDocs(memories);
  const total = docs.length;

  // Seed is always index 0
  const seedIdx = 0;

  // Tag DF
  const tagDf = new Map<string, number>();
  for (const doc of docs) {
    for (const tag of new Set(doc.tags)) tagDf.set(tag, (tagDf.get(tag) ?? 0) + 1);
  }

  const results: ScoredEdgeWithEvidence[] = [];

  // Score seed against each candidate
  for (let candidateIdx = 1; candidateIdx < total; candidateIdx += 1) {
    const scored = scorePair(seedIdx, candidateIdx, docs, tagDf, total);
    if (!scored || scored.weight < minWeight) continue;

    // Extract structured evidence from the scoring internals
    // (Re-derive to keep evidence consistent with the score)
    const left = docs[seedIdx];
    const right = docs[candidateIdx];

    const sharedEntities = shared(left.entityIds, right.entityIds);
    const sharedTags = byRarity(shared(left.tags, right.tags), tagDf);

    const sharedTerms: string[] = [];
    for (const term of left.distinctive) {
      if (right.distinctive.has(term)) sharedTerms.push(term);
      if (sharedTerms.length >= 6) break;
    }

    const similarity = sharedTerms.length > 0 ? cosine(left.vector, right.vector) : 0;
    const semanticGate = similarity >= SEMANTIC_MIN && sharedTerms.length >= 2;

    const rareCutoff = Math.max(
      RARE_TAG_DF_ABS,
      Math.min(POSTING_MAX, Math.floor(total * RARE_TAG_DF_RATIO))
    );
    const rareTag = sharedTags.length > 0 && (tagDf.get(sharedTags[0]) ?? 0) <= rareCutoff;
    const tagGate = sharedTags.length >= 2 || rareTag;

    const sameProject =
      left.projectId !== null && right.projectId !== null && left.projectId === right.projectId;

    const evidence: EdgeEvidence = {
      signals: {},
      signalFamilyCount: 0,
    };

    if (semanticGate) {
      evidence.signals.semantic = { similarity, sharedTerms: sharedTerms.slice(0, 4) };
      evidence.signalFamilyCount += 1;
    }

    if (tagGate) {
      evidence.signals.tag = { sharedTags: sharedTags.slice(0, 3), rare: rareTag };
      evidence.signalFamilyCount += 1;
    }

    if (sharedEntities.length > 0) {
      evidence.signals.entity = { sharedEntityIds: sharedEntities };
      evidence.signalFamilyCount += 1;
    }

    if (sameProject) {
      evidence.signals.project = true;
      // Project is a bonus, not a family — don't increment signalFamilyCount
    }

    results.push({
      memoryA: seed.id,
      memoryB: candidates[candidateIdx - 1].id,
      relation: scored.relation,
      weight: Math.round(scored.weight * 1000) / 1000,
      reason: scored.reason,
      evidence,
    });
  }

  // Sort by weight DESC for deterministic output
  results.sort((a, b) => b.weight - a.weight || (a.memoryB < b.memoryB ? -1 : 1));

  return results;
}


import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/lib/db/schema";
import { brainEntities, memories, memoryLinks, memoryMentions } from "@/lib/db/schema";
import { ftsMatchOn, ftsRankOn, hasSearchTerms } from "@/lib/search/fts";
import { embeddingsAvailable } from "../embedding/provider";
import { STOP_WORDS } from "../graph/relate";
import type { MemoryType } from "../constants";
import {
  rankCandidates,
  type RankedCandidate,
  type RetrievalCandidate,
  type RetrievalFeatures,
} from "./score";
import {
  processQuery,
  buildEnhancedQuery,
  extractEntityMatchWords,
  type ProcessedQuery,
} from "./query-understanding";

/**
 * Hybrid retrieval — the candidate-gathering half of ranking (P2).
 *
 * `score.ts` knows how to rank; this module knows where candidates come from and
 * which raw features to attach to them. The split is deliberate: the arithmetic
 * stays pure and unit-testable, and every database access lives here, where the
 * tenant scope and the row caps are all visible in one place.
 *
 * Three legs run against Postgres, each independently bounded:
 *
 *  - **lexical** — `ts_rank` over `memories.search_vector`, the same GIN-indexed
 *    generated column `brain_search` already uses. The raw rank is carried through
 *    unmodified, because normalizing it is set-relative work that only
 *    `rankCandidates` can do.
 *  - **entity** — memories whose stored mention spans point at entity nodes the
 *    query names. This is evidence, not inference: the span was written by
 *    enrichment and can be quoted back.
 *  - **graph** — a bounded breadth-first walk over explicit memory→memory links
 *    from the seeds, so a memory adjacent to a strong hit can surface even when it
 *    shares no words with the query.
 *
 * A fourth leg, semantic, abstains until an embedding provider exists (P9). It
 * abstains rather than voting zero; see the note on missing signals in `score.ts`.
 *
 * What this module guarantees:
 *  - every statement is filtered by `brain_id`, so a memory from another tenant
 *    cannot enter the pool — not even through `seedMemoryIds`;
 *  - every leg has a row cap, so the candidate pool is a constant and retrieval
 *    never becomes O(brain);
 *  - nothing is written. Recall counters and retrieval events belong to P5/P10 and
 *    to the caller that actually *uses* a memory, not to the act of ranking;
 *  - `searchMemories()` is untouched. This is an additional surface, so
 *    `brain_search` keeps behaving exactly as it does today.
 */

type RetrievalDb = PostgresJsDatabase<typeof schema>;

/** Bumped when the leg set or the feature extraction changes shape. */
export const RETRIEVAL_VERSION = "retrieve-v1";

/** Per-leg row caps. Their sum is the hard ceiling on the candidate pool. */
export const LEXICAL_CANDIDATE_LIMIT = 60;
export const ENTITY_CANDIDATE_LIMIT = 40;
export const GRAPH_CANDIDATE_LIMIT = 60;
export const CANDIDATE_POOL_MAX =
  LEXICAL_CANDIDATE_LIMIT + ENTITY_CANDIDATE_LIMIT + GRAPH_CANDIDATE_LIMIT;

/** How many entity nodes one query may resolve to. */
export const QUERY_ENTITY_LIMIT = 12;
/** Words shorter than this, and stop words, are not entity-name evidence. */
export const MIN_QUERY_WORD_CHARS = 3;
/** Ceiling on the alternation built into the entity-name regex. */
export const MAX_QUERY_WORDS = 12;

/** Graph walk bounds. Two hops is where "near something relevant" stops meaning much. */
export const GRAPH_MAX_HOPS = 2;
export const GRAPH_SEED_LIMIT = 8;
/** Edges read per hop. A hub memory cannot make one request unbounded. */
export const GRAPH_EDGE_LIMIT = 200;

export const RESULT_LIMIT_DEFAULT = 20;
export const RESULT_LIMIT_MAX = 100;
/** Ranked-but-dropped candidates reported back, so "why not this one" is answerable. */
export const OMITTED_REPORT_MAX = 25;

/**
 * Provenance quality per source type, in [0, 1]. A deterministic, documented table
 * rather than a heuristic: it only ever *tempers* confidence (see
 * `RetrievalFeatures.provenanceQuality`), so a claim the user typed themselves is
 * worth slightly more than the same claim recovered from a bulk import.
 */
export const PROVENANCE_QUALITY: Readonly<Record<string, number>> = {
  user: 1,
  manual_note: 0.95,
  agent: 0.85,
  api: 0.8,
  conversation: 0.7,
  imported_document: 0.65,
  system: 0.6,
};
/** An unrecognized source type is average, never zero. */
export const PROVENANCE_QUALITY_DEFAULT = 0.7;

/** Which leg put a candidate in the pool. A candidate may have several. */
export type RetrievalLeg = "lexical" | "entity" | "graph" | "semantic";

/**
 * The candidate row. Deliberately WITHOUT `content`: the pool can hold 160 rows and
 * shipping every body through the ranker would make retrieval cost proportional to
 * the size of the brain's text, not to the number of results. `contentChars` is
 * enough to plan a token budget; the context engine loads the full text for the
 * shortlist it actually keeps.
 */
export type CandidateMemory = {
  id: string;
  brainId: string;
  type: string;
  title: string;
  summary: string | null;
  contentChars: number;
  projectId: string | null;
  importance: number;
  confidence: number;
  sourceType: string;
  validityState: string;
  supersededById: string | null;
  recallCount: number;
  confirmationCount: number;
  lastRecalledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/** An entity node the query named, and the mention spans this memory holds for it. */
export type EntityEvidence = {
  entityId: string;
  name: string;
  type: string;
  mentions: number;
};

/** How the graph walk reached a candidate. `fromMemoryId` is the previous hop. */
export type GraphEvidence = {
  fromMemoryId: string;
  hops: number;
  linkType: string;
  direction: "outgoing" | "incoming";
};

export type MemoryCandidate = RetrievalCandidate & {
  memory: CandidateMemory;
  /** Every leg that voted for this candidate, in a stable order. */
  legs: RetrievalLeg[];
  entityEvidence: EntityEvidence[];
  graphEvidence: GraphEvidence | null;
};

export type RankedMemory = RankedCandidate<MemoryCandidate>;

export type RetrieveParams = {
  brainId: string;
  query?: string | null;
  /** Narrow to one project. Applied to every leg, including graph neighbours. */
  projectId?: string | null;
  types?: readonly MemoryType[];
  includeArchived?: boolean;
  /** Extra graph roots — `brain_related(memoryId)` passes the memory itself. */
  seedMemoryIds?: readonly string[];
  /** Never returned. Explicit seeds are excluded already; this is for the rest. */
  excludeMemoryIds?: readonly string[];
  limit?: number;
  maxHops?: number;
  /** Reference time for every decay function. Injected so tests are deterministic. */
  now?: Date;
};

export type RetrievalResult = {
  brainId: string;
  query: string | null;
  /** Processed query structure (content words, phrases, intent) */
  processedQuery: ProcessedQuery | null;
  /** Entity nodes the query resolved to. The denominator of `entityOverlap`. */
  queryEntities: { id: string; name: string; type: string }[];
  /** Candidates contributed per leg, before the merge. Diagnostics and benchmarks. */
  legCounts: Record<RetrievalLeg, number>;
  /** Size of the merged pool. */
  candidates: number;
  results: RankedMemory[];
  /** The next-best candidates that did not fit `limit`, bounded and still ranked. */
  omitted: RankedMemory[];
  /** False when no embedding provider is configured — the semantic leg abstained. */
  semanticAvailable: boolean;
};

/**
 * One projection for every leg, so a candidate carries the same features no matter
 * which leg found it. `length(content)` is computed in Postgres — the body itself
 * stays in the database.
 */
const candidateColumns = {
  id: memories.id,
  brainId: memories.brainId,
  type: memories.type,
  title: memories.title,
  summary: memories.summary,
  contentChars: sql<number>`length(${memories.content})::int`,
  projectId: memories.projectId,
  importance: memories.importance,
  confidence: memories.confidence,
  sourceType: memories.sourceType,
  validityState: memories.validityState,
  supersededById: memories.supersededById,
  recallCount: memories.recallCount,
  confirmationCount: memories.confirmationCount,
  lastRecalledAt: memories.lastRecalledAt,
  createdAt: memories.createdAt,
  updatedAt: memories.updatedAt,
};

/**
 * The visibility scope, as WHERE fragments every leg must include.
 *
 * `brainId` first and always: this is the one condition that makes cross-tenant
 * leakage structurally impossible rather than merely unlikely. Deleted memories are
 * always excluded; archived ones only on request; a `type`/`projectId` filter
 * applies to graph neighbours too, because a filtered request that quietly returns
 * unfiltered neighbours is a filter that does not work.
 */
function visibilityScope(params: RetrieveParams): SQL[] {
  const scope: SQL[] = [eq(memories.brainId, params.brainId), isNull(memories.deletedAt)];
  if (!params.includeArchived) scope.push(isNull(memories.archivedAt));
  if (params.types && params.types.length > 0) {
    scope.push(inArray(memories.type, [...params.types]));
  }
  if (params.projectId) scope.push(eq(memories.projectId, params.projectId));
  return scope;
}

/**
 * The query's words, as entity-name evidence.
 *
 * DEPRECATED: Use extractEntityMatchWords(processQuery(query)) instead.
 * Kept for backward compatibility with direct callers.
 *
 * Stop words come from `graph/relate.ts` — the same bilingual list entity
 * extraction rejects, because two lists would drift and a drifted list is how
 * "yang" ends up resolving to an entity node. Splitting on non-letter/non-digit
 * also means every surviving word is alphanumeric, so it is safe to interpolate
 * into the regex alternation below without escaping.
 */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= MIN_QUERY_WORD_CHARS && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, MAX_QUERY_WORDS);
}

/**
 * POSIX word-boundary alternation. `~*` with this pattern matches the entity "Redis"
 * for the query "redis" without also matching every node that merely contains those
 * letters — the same construction `recall.ts` uses, kept identical on purpose.
 */
export function entityNamePattern(words: readonly string[]): string {
  return `(^|[^[:alnum:]])(${words.join("|")})([^[:alnum:]]|$)`;
}

/**
 * Entity nodes this query names, most-used first. Aliases count: matching "MCP"
 * must resolve to the node the brain already curates, not to nothing.
 */
async function resolveQueryEntities(
  db: RetrievalDb,
  brainId: string,
  words: readonly string[]
): Promise<{ id: string; name: string; type: string }[]> {
  if (words.length === 0) return [];
  const pattern = entityNamePattern(words);

  return db
    .select({ id: brainEntities.id, name: brainEntities.name, type: brainEntities.type })
    .from(brainEntities)
    .where(
      and(
        eq(brainEntities.brainId, brainId),
        or(
          sql`${brainEntities.name} ~* ${pattern}`,
          sql`EXISTS (
            SELECT 1 FROM unnest(coalesce(${brainEntities.aliases}, ARRAY[]::text[])) AS alias
            WHERE alias ~* ${pattern}
          )`
        )
      )
    )
    .orderBy(desc(brainEntities.mentionCount), asc(brainEntities.name))
    .limit(QUERY_ENTITY_LIMIT);
}

/**
 * Lexical leg. Same column, same helpers and same prefix-tsquery as `brain_search`,
 * so what the search box finds is exactly what retrieval considers relevant.
 *
 * The ordering matters even though the result is re-ranked afterwards: it decides
 * *which* 60 rows a large match set contributes, and dropping the strongest matches
 * before ranking would make the ranking irrelevant.
 */
async function lexicalLeg(
  db: RetrievalDb,
  params: RetrieveParams,
  query: string
): Promise<{ memory: CandidateMemory; lexicalRank: number }[]> {
  const rows = await db
    .select({ ...candidateColumns, lexicalRank: ftsRankOn(memories.searchVector, query) })
    .from(memories)
    .where(and(...visibilityScope(params), ftsMatchOn(memories.searchVector, query)))
    .orderBy(
      desc(ftsRankOn(memories.searchVector, query)),
      desc(memories.importance),
      desc(memories.id)
    )
    .limit(LEXICAL_CANDIDATE_LIMIT);

  return rows.map(({ lexicalRank, ...memory }) => ({ memory, lexicalRank }));
}

/**
 * Entity leg: memories that hold a stored mention span for one of the query's
 * entities. Ranked by how many *distinct* query entities each memory covers, so a
 * memory about both "Postgres" and "pgvector" beats one that names Postgres twice.
 *
 * Two statements rather than one join back to `memories`: the first picks the rows
 * (bounded), the second fetches the spans that justify them (bounded by the first).
 * The alternative — one join returning every span — is unbounded in the number of
 * mentions, which is exactly the shape a busy entity turns into a slow query.
 */
async function entityLeg(
  db: RetrievalDb,
  params: RetrieveParams,
  entityIds: readonly string[]
): Promise<{ memoryId: string; matched: number }[]> {
  if (entityIds.length === 0) return [];
  const distinctEntities = sql<number>`count(distinct ${memoryMentions.entityId})::int`;

  return db
    .select({ memoryId: memoryMentions.memoryId, matched: distinctEntities })
    .from(memoryMentions)
    .innerJoin(memories, eq(memories.id, memoryMentions.memoryId))
    .where(
      and(
        eq(memoryMentions.brainId, params.brainId),
        inArray(memoryMentions.entityId, [...entityIds]),
        ...visibilityScope(params)
      )
    )
    .groupBy(memoryMentions.memoryId)
    .orderBy(desc(distinctEntities), asc(memoryMentions.memoryId))
    .limit(ENTITY_CANDIDATE_LIMIT);
}

/**
 * The spans behind the entity leg, grouped per memory. This is what makes an entity
 * match explainable: the answer to "why is this memory here" is a node name and a
 * count of real, stored occurrences, not a similarity number.
 */
async function loadEntityEvidence(
  db: RetrievalDb,
  brainId: string,
  memoryIds: readonly string[],
  queryEntities: readonly { id: string; name: string; type: string }[]
): Promise<Map<string, EntityEvidence[]>> {
  const evidence = new Map<string, EntityEvidence[]>();
  if (memoryIds.length === 0 || queryEntities.length === 0) return evidence;

  const rows = await db
    .select({
      memoryId: memoryMentions.memoryId,
      entityId: memoryMentions.entityId,
      mentions: sql<number>`count(*)::int`,
    })
    .from(memoryMentions)
    .where(
      and(
        eq(memoryMentions.brainId, brainId),
        inArray(memoryMentions.memoryId, [...memoryIds]),
        inArray(
          memoryMentions.entityId,
          queryEntities.map((entity) => entity.id)
        )
      )
    )
    .groupBy(memoryMentions.memoryId, memoryMentions.entityId);

  const nodes = new Map(queryEntities.map((entity) => [entity.id, entity]));
  for (const row of rows) {
    const node = nodes.get(row.entityId);
    if (!node) continue;
    const list = evidence.get(row.memoryId) ?? [];
    list.push({
      entityId: node.id,
      name: node.name,
      type: node.type,
      mentions: Number(row.mentions ?? 0),
    });
    evidence.set(row.memoryId, list);
  }

  for (const list of evidence.values()) {
    list.sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name));
  }
  return evidence;
}

/**
 * Bounded breadth-first walk over explicit memory→memory links.
 *
 * Only `memory_links` rows are followed, and only in this brain: the walk cannot
 * step outside the tenant even if a caller hands in a foreign `seedMemoryId`, since
 * every hop is filtered by `brain_id` and the resulting ids are re-loaded through
 * {@link visibilityScope} before they can become candidates.
 *
 * Links are traversed in both directions. "A supersedes B" is a relationship
 * whichever end you start from, and treating the edge as one-way would make a
 * memory's own replacement invisible from it.
 *
 * Seeds keep distance 0 and are never emitted — a seed is not a discovery, and for
 * `brain_related(memoryId)` returning the memory itself would be noise. Nothing is
 * silently dropped otherwise: a row whose target is missing is skipped, and the
 * database's own CHECK constraints guarantee that cannot happen for `targetType =
 * 'memory'`.
 */
async function graphLeg(
  db: RetrievalDb,
  brainId: string,
  seeds: readonly string[],
  maxHops: number
): Promise<Map<string, GraphEvidence>> {
  const reached = new Map<string, GraphEvidence>();
  if (seeds.length === 0 || maxHops < 1) return reached;

  const distance = new Map<string, number>(seeds.map((seed) => [seed, 0]));
  let frontier = [...seeds];

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop += 1) {
    const edges = await db
      .select({
        source: memoryLinks.sourceMemoryId,
        target: memoryLinks.targetMemoryId,
        linkType: memoryLinks.linkType,
      })
      .from(memoryLinks)
      .where(
        and(
          eq(memoryLinks.brainId, brainId),
          eq(memoryLinks.targetType, "memory"),
          or(
            inArray(memoryLinks.sourceMemoryId, frontier),
            inArray(memoryLinks.targetMemoryId, frontier)
          )
        )
      )
      // Stable order, so a brain with more edges than the cap always contributes the
      // same ones rather than whatever the planner happened to return.
      .orderBy(asc(memoryLinks.createdAt), asc(memoryLinks.id))
      .limit(GRAPH_EDGE_LIMIT);

    const next: string[] = [];
    const inFrontier = new Set(frontier);

    for (const edge of edges) {
      if (!edge.target) continue;
      const fromSource = inFrontier.has(edge.source);
      const from = fromSource ? edge.source : edge.target;
      const to = fromSource ? edge.target : edge.source;
      if (distance.has(to)) continue;

      distance.set(to, hop);
      next.push(to);
      reached.set(to, {
        fromMemoryId: from,
        hops: hop,
        linkType: edge.linkType,
        direction: fromSource ? "outgoing" : "incoming",
      });
      if (reached.size >= GRAPH_CANDIDATE_LIMIT) return reached;
    }
    frontier = next;
  }

  return reached;
}

/**
 * Load the candidate rows for ids the entity and graph legs produced.
 *
 * The visibility scope is re-applied here, which is what makes those legs safe: they
 * work from join tables, and an id that is deleted, archived, filtered out or from
 * another brain simply does not come back and therefore never becomes a candidate.
 */
async function loadCandidateRows(
  db: RetrievalDb,
  params: RetrieveParams,
  ids: readonly string[]
): Promise<CandidateMemory[]> {
  if (ids.length === 0) return [];
  return db
    .select(candidateColumns)
    .from(memories)
    .where(and(...visibilityScope(params), inArray(memories.id, [...ids])));
}

/** Documented, deterministic provenance quality. Never zero for a real row. */
export function provenanceQuality(sourceType: string): number {
  return PROVENANCE_QUALITY[sourceType] ?? PROVENANCE_QUALITY_DEFAULT;
}

function uniqueIds(ids: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  for (const id of ids) if (id) seen.add(id);
  return [...seen];
}

/** Query-independent features. Present for every candidate, whichever leg found it. */
function baseFeatures(memory: CandidateMemory): RetrievalFeatures {
  return {
    importance: memory.importance,
    confidence: memory.confidence,
    provenanceQuality: provenanceQuality(memory.sourceType),
    updatedAt: memory.updatedAt,
    lastRecalledAt: memory.lastRecalledAt,
    recallCount: memory.recallCount,
    confirmationCount: memory.confirmationCount,
    validityState: memory.validityState,
  };
}

/**
 * Gather, merge and rank candidates for one request. THE entry point of P2.
 *
 * Legs that can run independently do. The pool is then ranked as a whole, because
 * lexical normalization is set-relative: a candidate's score depends on the other
 * candidates, so partial ranking per leg would produce numbers that cannot be
 * compared.
 *
 * A request with no query and no seeds returns nothing rather than "the whole brain
 * ranked by quality" — with no match evidence at all, quality is not relevance, and
 * `score.ts` caps such a candidate at {@link QUALITY_SHARE} for exactly that reason.
 *
 * ENHANCED with query understanding layer (P1):
 * - Processes natural language queries (removes imperatives, detects phrases)
 * - Builds enhanced query for FTS (phrase boosting)
 * - Extracts entity match words (more permissive than content words)
 */
export async function retrieveMemories(
  db: RetrievalDb,
  params: RetrieveParams
): Promise<RetrievalResult> {
  const now = params.now ?? new Date();
  const limit = Math.min(
    Math.max(1, Math.trunc(params.limit ?? RESULT_LIMIT_DEFAULT)),
    RESULT_LIMIT_MAX
  );
  const maxHops = Math.min(
    Math.max(0, Math.trunc(params.maxHops ?? GRAPH_MAX_HOPS)),
    GRAPH_MAX_HOPS
  );
  const rawQuery = params.query?.trim() || null;

  // PHASE 1: Query Understanding
  const processed = rawQuery ? processQuery(rawQuery) : null;
  const query = processed ? buildEnhancedQuery(processed) : null;
  const entityWords = processed ? extractEntityMatchWords(processed) : [];

  const [semanticAvailable, lexical, entityResolved] = await Promise.all([
    embeddingsAvailable(),
    query && hasSearchTerms(query) ? lexicalLeg(db, params, query) : Promise.resolve([]),
    (async () => {
      const entities = await resolveQueryEntities(db, params.brainId, entityWords);
      const hits = await entityLeg(db, params, entities.map((entity) => entity.id));
      return { entities, hits };
    })(),
  ]);
  const { entities: queryEntities, hits: entityHits } = entityResolved;

  // Explicit seeds are roots, not results: `brain_related(memoryId)` must not
  // return the memory it was asked about. Lexical/entity seeds stay eligible — a
  // strong hit that is also a graph hub is a legitimate result.
  const explicitSeeds = uniqueIds(params.seedMemoryIds ?? []).slice(0, GRAPH_SEED_LIMIT);
  const excluded = new Set<string>([...explicitSeeds, ...uniqueIds(params.excludeMemoryIds ?? [])]);

  const seeds = uniqueIds([
    ...explicitSeeds,
    ...lexical.map((row) => row.memory.id),
    ...entityHits.map((hit) => hit.memoryId),
  ]).slice(0, GRAPH_SEED_LIMIT);
  const reached = await graphLeg(db, params.brainId, seeds, maxHops);

  // One statement for every id the join-table legs produced. Rows the lexical leg
  // already fetched are reused rather than read twice.
  const loaded = new Map<string, CandidateMemory>(
    lexical.map((row) => [row.memory.id, row.memory])
  );
  const missing = uniqueIds([...entityHits.map((hit) => hit.memoryId), ...reached.keys()]).filter(
    (id) => !loaded.has(id) && !excluded.has(id)
  );
  for (const row of await loadCandidateRows(db, params, missing)) loaded.set(row.id, row);

  const pool = new Map<string, MemoryCandidate>();
  const legCounts: Record<RetrievalLeg, number> = {
    lexical: 0,
    entity: 0,
    graph: 0,
    // Abstains until an embedding provider exists (P9). Reported so a deployment can
    // see at a glance whether the leg is contributing.
    semantic: 0,
  };

  const candidateFor = (memory: CandidateMemory): MemoryCandidate => {
    const existing = pool.get(memory.id);
    if (existing) return existing;
    const created: MemoryCandidate = {
      id: memory.id,
      memory,
      legs: [],
      entityEvidence: [],
      graphEvidence: null,
      features: baseFeatures(memory),
    };
    pool.set(memory.id, created);
    return created;
  };

  for (const row of lexical) {
    if (excluded.has(row.memory.id)) continue;
    const candidate = candidateFor(row.memory);
    candidate.features.lexicalRank = row.lexicalRank;
    candidate.legs.push("lexical");
    legCounts.lexical += 1;
  }

  const entityEvidence = await loadEntityEvidence(
    db,
    params.brainId,
    entityHits.map((hit) => hit.memoryId).filter((id) => loaded.has(id) && !excluded.has(id)),
    queryEntities
  );

  for (const hit of entityHits) {
    const memory = loaded.get(hit.memoryId);
    if (!memory || excluded.has(hit.memoryId)) continue;
    const candidate = candidateFor(memory);
    // Share of the query's entities this memory covers. The denominator is what the
    // query resolved to, so "covers 2 of 2" beats "covers 2 of 6" — which is the
    // whole point of scoring overlap rather than raw mention counts.
    candidate.features.entityOverlap =
      queryEntities.length > 0 ? Math.min(1, Number(hit.matched ?? 0) / queryEntities.length) : null;
    candidate.entityEvidence = entityEvidence.get(hit.memoryId) ?? [];
    candidate.legs.push("entity");
    legCounts.entity += 1;
  }

  for (const [memoryId, hop] of reached) {
    const memory = loaded.get(memoryId);
    if (!memory || excluded.has(memoryId)) continue;
    const candidate = candidateFor(memory);
    candidate.graphEvidence = hop;
    candidate.features.graphHops = hop.hops;
    // A direct link is an assertion somebody made explicitly — the strongest edge
    // kind in this graph (nothing writes memory→memory links automatically), so it
    // also votes on the `related` signal. Beyond one hop only proximity remains.
    if (hop.hops === 1) candidate.features.relationshipStrength = 1;
    candidate.legs.push("graph");
    legCounts.graph += 1;
  }

  const ranked = rankCandidates([...pool.values()], { now });

  return {
    brainId: params.brainId,
    query: rawQuery,
    processedQuery: processed,
    queryEntities,
    legCounts,
    candidates: ranked.length,
    results: ranked.slice(0, limit),
    omitted: ranked.slice(limit, limit + OMITTED_REPORT_MAX),
    semanticAvailable,
  };
}

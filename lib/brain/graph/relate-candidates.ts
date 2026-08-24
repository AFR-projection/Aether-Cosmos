import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db as applicationDb } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { memories, memoryMentions, memoryTagMap, memoryLinks } from "@/lib/db/schema";
import { ftsAnyMatchOn, ftsAnyRankOn } from "@/lib/search/fts";
import { STOP_WORDS, type RelateMemory } from "./relate";

/**
 * PHASE 2: Bounded candidate generation for single-seed relate jobs.
 *
 * Five independent probes, each index-backed and capped. Union → dedupe → deterministic
 * ordering. Cost is O(candidates), independent of brain size.
 *
 * Design: probes fetch memory IDs only, then one bulk load at the end fetches full
 * RelateMemory records. This keeps the probe queries simple and avoids N+1.
 */

const PROBE_LIMITS = {
  /** Shared entities — strongest signal */
  sharedEntities: 40,
  /** Shared tags (requires new index) */
  sharedTags: 30,
  /** Same project */
  sameProject: 20,
  /** FTS / rare terms */
  lexical: 40,
  /** 1-hop explicit neighbors */
  graphProximity: 20,
  /** Global cap after union + dedupe */
  total: 120,
} as const;

/** Terms fed to the lexical probe. Bounded so the OR-tsquery stays small. */
const PROBE_TERM_MAX = 12;
const PROBE_TERM_MIN_LEN = 3;

/**
 * Reduce free text to the terms worth probing on: the same stopword list and
 * length bounds the scorer uses, deduped, first-occurrence order (deterministic),
 * capped at PROBE_TERM_MAX.
 *
 * Recall here only has to be good enough to surface candidates — `relateOne` does
 * the real scoring, so a term this drops can only cost a candidate, never
 * fabricate one.
 */
export function probeTerms(text: string): string {
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < PROBE_TERM_MIN_LEN || raw.length > 24) continue;
    if (STOP_WORDS.has(raw)) continue;
    if (!/\p{L}/u.test(raw)) continue;
    seen.add(raw);
    if (seen.size >= PROBE_TERM_MAX) break;
  }
  return Array.from(seen).join(" ");
}

/**
 * Generate candidates for one seed memory using five bounded probes.
 *
 * Returns memory IDs only; caller loads full RelateMemory records in bulk.
 * Deterministic: same seed state → same candidate list in same order.
 */
export async function generateCandidates(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string,
  seedEntityIds: string[],
  seedTagIds: string[],
  seedProjectId: string | null
): Promise<string[]> {
  const candidateSet = new Set<string>();

  // Probe 1: Shared entities (strongest signal, highest cap)
  if (seedEntityIds.length > 0) {
    const entityCandidates = await db
      .select({ memoryId: memoryMentions.memoryId })
      .from(memoryMentions)
      .innerJoin(memories, eq(memories.id, memoryMentions.memoryId))
      .where(
        and(
          eq(memoryMentions.brainId, brainId),
          inArray(memoryMentions.entityId, seedEntityIds),
          isNull(memories.deletedAt)
        )
      )
      .groupBy(memoryMentions.memoryId)
      // Deterministic truncation: a tie on shared-entity count is broken by memory id,
      // so the same candidates survive the cap on every run (same input → same output).
      .orderBy(desc(sql`count(*)`), asc(memoryMentions.memoryId))
      .limit(PROBE_LIMITS.sharedEntities);

    for (const row of entityCandidates) {
      if (row.memoryId !== seedMemoryId) candidateSet.add(row.memoryId);
    }
  }

  // Probe 2: Shared tags (requires memory_tag_map_tag_idx)
  if (seedTagIds.length > 0) {
    const tagCandidates = await db
      .select({ memoryId: memoryTagMap.memoryId })
      .from(memoryTagMap)
      .innerJoin(memories, eq(memories.id, memoryTagMap.memoryId))
      .where(
        and(
          inArray(memoryTagMap.tagId, seedTagIds),
          isNull(memories.deletedAt),
          eq(memories.brainId, brainId)
        )
      )
      .groupBy(memoryTagMap.memoryId)
      // Most shared tags first; id breaks ties so the cap is deterministic.
      .orderBy(desc(sql`count(*)`), asc(memoryTagMap.memoryId))
      .limit(PROBE_LIMITS.sharedTags);

    for (const row of tagCandidates) {
      if (row.memoryId !== seedMemoryId) candidateSet.add(row.memoryId);
    }
  }

  // Probe 3: Same project (if seed has one)
  if (seedProjectId !== null) {
    const projectCandidates = await db
      .select({ id: memories.id })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          eq(memories.projectId, seedProjectId),
          isNull(memories.deletedAt)
        )
      )
      .orderBy(desc(memories.createdAt), asc(memories.id))
      .limit(PROBE_LIMITS.sameProject);

    for (const row of projectCandidates) {
      if (row.id !== seedMemoryId) candidateSet.add(row.id);
    }
  }

  // Probe 4: Lexical / FTS over the seed's own distinctive terms.
  //
  // Uses the shared lib/search/fts helpers so the tsquery config ('simple') matches
  // the generated `memories.search_vector` column. An earlier cut hand-rolled
  // `websearch_to_tsquery('english', ...)`, which disagrees with the indexed config
  // and so could not use memories_search_vector_idx reliably.
  const [seedMem] = await db
    .select({ title: memories.title, summary: memories.summary })
    .from(memories)
    .where(and(eq(memories.id, seedMemoryId), eq(memories.brainId, brainId)))
    .limit(1);

  if (seedMem) {
    const query = probeTerms(`${seedMem.title} ${seedMem.summary || ""}`);
    if (query.length > 0) {
      const lexicalCandidates = await db
        .select({ id: memories.id })
        .from(memories)
        .where(
          and(
            eq(memories.brainId, brainId),
            isNull(memories.deletedAt),
            ftsAnyMatchOn(memories.searchVector, query)
          )
        )
        .orderBy(desc(ftsAnyRankOn(memories.searchVector, query)), asc(memories.id))
        .limit(PROBE_LIMITS.lexical);

      for (const row of lexicalCandidates) {
        if (row.id !== seedMemoryId) candidateSet.add(row.id);
      }
    }
  }

  // Probe 5: 1-hop explicit neighbors from memory_links
  const explicitNeighbors = await db
    .select({
      targetMemoryId: memoryLinks.targetMemoryId,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.sourceMemoryId, seedMemoryId),
        eq(memoryLinks.targetType, "memory")
      )
    )
    .orderBy(asc(memoryLinks.targetMemoryId))
    .limit(PROBE_LIMITS.graphProximity);

  for (const row of explicitNeighbors) {
    if (row.targetMemoryId && row.targetMemoryId !== seedMemoryId) {
      candidateSet.add(row.targetMemoryId);
    }
  }

  // Also check backlinks (memory_links pointing TO seed)
  const backlinks = await db
    .select({
      sourceMemoryId: memoryLinks.sourceMemoryId,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.targetMemoryId, seedMemoryId),
        eq(memoryLinks.targetType, "memory")
      )
    )
    .orderBy(asc(memoryLinks.sourceMemoryId))
    .limit(PROBE_LIMITS.graphProximity);

  for (const row of backlinks) {
    if (row.sourceMemoryId !== seedMemoryId) candidateSet.add(row.sourceMemoryId);
  }

  // Convert set to array, apply global cap, deterministic order
  const candidates = Array.from(candidateSet)
    // Sort BEFORE the cap, not after: slicing first would make the surviving set
    // depend on probe insertion order, so a union larger than the cap could keep a
    // different 120 ids run to run. Sorting first makes the cap deterministic.
    .sort()
    .slice(0, PROBE_LIMITS.total);

  return candidates;
}

/**
 * Load full RelateMemory records for a list of memory IDs.
 *
 * Returns in the same order as input IDs. Filters soft-deleted and cross-brain IDs
 * (defensive — probes should never return them, but double-check for security).
 *
 * Also returns each memory's `contentHash`, which the persistence layer stores on the
 * derived edge so staleness can be detected later without re-scoring.
 */
export async function loadRelateMemories(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  memoryIds: string[]
): Promise<{ records: RelateMemory[]; hashes: Map<string, string> }> {
  if (memoryIds.length === 0) return { records: [], hashes: new Map() };

  // Load memories
  const memRows = await db
    .select({
      id: memories.id,
      title: memories.title,
      summary: memories.summary,
      content: memories.content,
      projectId: memories.projectId,
      contentHash: memories.contentHash,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        inArray(memories.id, memoryIds),
        isNull(memories.deletedAt)
      )
    );

  const memMap = new Map(memRows.map((m) => [m.id, m]));

  // Load tags
  const tagRows = await db
    .select({
      memoryId: memoryTagMap.memoryId,
      tagName: schema.memoryTags.name,
    })
    .from(memoryTagMap)
    .innerJoin(schema.memoryTags, eq(schema.memoryTags.id, memoryTagMap.tagId))
    .where(inArray(memoryTagMap.memoryId, memoryIds));

  const tagMap = new Map<string, string[]>();
  for (const row of tagRows) {
    if (!tagMap.has(row.memoryId)) tagMap.set(row.memoryId, []);
    tagMap.get(row.memoryId)!.push(row.tagName);
  }

  // Load entity IDs (from memory_mentions)
  const entityRows = await db
    .select({
      memoryId: memoryMentions.memoryId,
      entityId: memoryMentions.entityId,
    })
    .from(memoryMentions)
    .where(
      and(
        eq(memoryMentions.brainId, brainId),
        inArray(memoryMentions.memoryId, memoryIds)
      )
    );

  const entityMap = new Map<string, string[]>();
  for (const row of entityRows) {
    if (!entityMap.has(row.memoryId)) entityMap.set(row.memoryId, []);
    entityMap.get(row.memoryId)!.push(row.entityId);
  }

  // Assemble RelateMemory records in input order
  const records: RelateMemory[] = [];
  const hashes = new Map<string, string>();
  for (const id of memoryIds) {
    const mem = memMap.get(id);
    if (!mem) continue; // Filtered out (deleted or wrong brain)

    records.push({
      id: mem.id,
      title: mem.title,
      content: `${mem.summary || ""}\n${mem.content || ""}`.trim(),
      tags: tagMap.get(mem.id) || [],
      projectId: mem.projectId,
      entityIds: entityMap.get(mem.id) || [],
    });
    // Empty string, not null: the edge column is NOT NULL and a legacy row with no
    // hash must still be storable — it just reads as permanently stale.
    hashes.set(mem.id, mem.contentHash ?? "");
  }

  return { records, hashes };
}

/**
 * Generate candidates and load their full records in one call.
 * Convenience wrapper for the worker.
 *
 * `hashes` carries every loaded memory's `contentHash` (seed included) so the
 * persistence layer can stamp `source_hash_a` / `source_hash_b` on each edge
 * without a second round trip.
 */
export async function generateAndLoadCandidates(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  seedMemoryId: string
): Promise<{ seed: RelateMemory; candidates: RelateMemory[]; hashes: Map<string, string> }> {
  // Load seed first to get its entity/tag/project IDs
  const seedLoad = await loadRelateMemories(db, brainId, [seedMemoryId]);
  const seedRecord = seedLoad.records[0];
  if (!seedRecord) {
    throw new Error(`Seed memory ${seedMemoryId} not found or deleted`);
  }

  // Load seed's tag IDs (need IDs for the probe, not names)
  const seedTagRows = await db
    .select({ tagId: memoryTagMap.tagId })
    .from(memoryTagMap)
    .where(eq(memoryTagMap.memoryId, seedMemoryId));

  const seedTagIds = seedTagRows.map((r) => r.tagId);

  // Generate candidate IDs
  const candidateIds = await generateCandidates(
    db,
    brainId,
    seedMemoryId,
    seedRecord.entityIds,
    seedTagIds,
    seedRecord.projectId
  );

  // Load candidate records
  const candidateLoad = await loadRelateMemories(db, brainId, candidateIds);

  const hashes = new Map(seedLoad.hashes);
  for (const [id, hash] of candidateLoad.hashes) hashes.set(id, hash);

  return { seed: seedRecord, candidates: candidateLoad.records, hashes };
}

// Default exports using application DB
export const generateCandidatesDefault = (
  brainId: string,
  seedMemoryId: string,
  seedEntityIds: string[],
  seedTagIds: string[],
  seedProjectId: string | null
) => generateCandidates(applicationDb, brainId, seedMemoryId, seedEntityIds, seedTagIds, seedProjectId);

export const loadRelateMemoriesDefault = (brainId: string, memoryIds: string[]) =>
  loadRelateMemories(applicationDb, brainId, memoryIds);

export const generateAndLoadCandidatesDefault = (brainId: string, seedMemoryId: string) =>
  generateAndLoadCandidates(applicationDb, brainId, seedMemoryId);

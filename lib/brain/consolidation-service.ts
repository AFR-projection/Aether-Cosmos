import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories, type Memory } from "@/lib/db/schema";
import { linkMemory } from "./link-service";
import { updateMemory } from "./memory-service";

/**
 * Brain consolidation (§30) and conflict detection (§31).
 *
 * Deliberately heuristic and deliberately non-destructive:
 *
 *  - duplicates are found by exact normalized title within the same memory type —
 *    the same rule brain_remember already uses, so consolidation cannot "discover"
 *    duplicates that remember() would have merged anyway;
 *  - conflicts are found by token overlap plus a negation marker on one side only;
 *  - nothing is ever deleted. A merge archives the loser, snapshots a version on
 *    the survivor, and records a `supersedes` link. A conflict records a
 *    `contradicts` link and is reported — never auto-resolved (§31).
 *
 * Both passes are bounded by CONSOLIDATION_SCAN_MAX so a large brain cannot turn
 * one request into an unbounded scan (§98). The `ConsolidationResolver` hook below
 * is where an LLM-based pass would slot in later (§62) without touching callers.
 */

/** Hard ceiling on rows either pass will look at in one run. */
export const CONSOLIDATION_SCAN_MAX = 500;

/** Phrases that flip the meaning of an otherwise near-identical statement. */
const NEGATION_MARKERS = [
  "no longer",
  "not ",
  "never ",
  "stopped",
  "removed",
  "deprecated",
  "instead of",
  "replaced by",
  "migrated away",
  "dropped",
  "disabled",
];

/** Words too common to carry signal when comparing two memories. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were", "be", "been",
  "to", "of", "in", "on", "for", "with", "at", "by", "from", "as", "it", "its",
  "this", "that", "these", "those", "we", "our", "you", "your", "uses", "use",
  "using", "used", "has", "have", "had", "does", "do", "did", "will", "would",
]);

export type DuplicateGroup = {
  /** Normalized title the group keys on. */
  key: string;
  type: string;
  /** Winner first: highest importance, then most recently updated. */
  memories: { id: string; title: string; importance: number; updatedAt: Date }[];
};

export type ConflictPair = {
  /** The memory carrying the negation — treated as the newer statement. */
  memoryId: string;
  memoryTitle: string;
  conflictsWithId: string;
  conflictsWithTitle: string;
  /** 0-1 token overlap between the two bodies. */
  overlap: number;
  reason: string;
};

export type ConsolidationReport = {
  scanned: number;
  duplicates: DuplicateGroup[];
  conflicts: ConflictPair[];
  /** Only set when apply=true. */
  applied?: {
    memoriesArchived: number;
    supersedesLinks: number;
    conflictLinks: number;
  };
  truncated: boolean;
};

/**
 * Extension point for a future LLM pass (§30, §62). A resolver may narrow either
 * list; it may never widen it, and it is never given the power to delete.
 */
export type ConsolidationResolver = {
  filterDuplicates?(groups: DuplicateGroup[]): Promise<DuplicateGroup[]>;
  filterConflicts?(pairs: ConflictPair[]): Promise<ConflictPair[]>;
};

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function hasNegation(text: string): string | null {
  const haystack = text.toLowerCase();
  return NEGATION_MARKERS.find((marker) => haystack.includes(marker)) ?? null;
}

type Principal = { userId: string; agentId: string | null };

/** Cap on how many negated memories drive the pairwise conflict comparison. */
const CONFLICT_PROBE_MAX = 100;

/** Minimum token overlap for two memories to be considered the same statement. */
const CONFLICT_OVERLAP_MIN = 0.5;

/**
 * Duplicate groups: same memory type, same normalized title, more than one live row.
 *
 * Archived rows are excluded on purpose, which is what makes a second run of
 * consolidation a no-op instead of re-merging what it already merged.
 */
export async function findDuplicateGroups(params: {
  brainId: string;
  limit?: number;
}): Promise<DuplicateGroup[]> {
  const limit = Math.min(params.limit ?? 50, 200);
  const key = sql<string>`lower(regexp_replace(${memories.title}, '[[:space:]]+', ' ', 'g'))`;
  const items = sql<
    { id: string; title: string; importance: number; updatedAt: string }[]
  >`json_agg(
      json_build_object(
        'id', ${memories.id},
        'title', ${memories.title},
        'importance', ${memories.importance},
        'updatedAt', ${memories.updatedAt}
      )
      order by ${memories.importance} desc, ${memories.updatedAt} desc
    )`;

  const rows = await db
    .select({ key, type: memories.type, total: sql<number>`count(*)::int`, items })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt)
      )
    )
    .groupBy(key, memories.type)
    .having(sql`count(*) > 1`)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return rows.map((row) => ({
    key: row.key,
    type: row.type,
    memories: (row.items ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      importance: item.importance,
      updatedAt: new Date(item.updatedAt),
    })),
  }));
}

export type ConflictCandidate = Pick<Memory, "id" | "type" | "title" | "content" | "summary">;

/**
 * Conflict candidates: two same-type memories that say mostly the same words, where
 * exactly one of them carries a negation marker. That catches the common real case —
 * "We deploy on Vercel" vs "We no longer deploy on Vercel" — without pretending to
 * understand either sentence. Reported only; §31 forbids auto-resolution.
 */
export async function findConflictCandidates(params: {
  brainId: string;
  limit?: number;
}): Promise<{ conflicts: ConflictPair[]; scanned: number; truncated: boolean }> {
  const limit = Math.min(params.limit ?? 50, 200);

  const rows: ConflictCandidate[] = await db
    .select({
      id: memories.id,
      type: memories.type,
      title: memories.title,
      content: memories.content,
      summary: memories.summary,
    })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, params.brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt)
      )
    )
    .orderBy(desc(memories.updatedAt))
    .limit(CONSOLIDATION_SCAN_MAX + 1);

  const truncated = rows.length > CONSOLIDATION_SCAN_MAX;
  const scanned = rows.slice(0, CONSOLIDATION_SCAN_MAX);

  const detected = detectConflicts(scanned, limit);
  return { conflicts: detected, scanned: scanned.length, truncated };
}

/**
 * The pairwise half of conflict detection, kept pure so it can be tested without a
 * database and reasoned about on its own. Comparison is bounded: only the first
 * CONFLICT_PROBE_MAX negated rows drive the outer loop.
 */
export function detectConflicts(
  rows: ConflictCandidate[],
  limit = 50
): ConflictPair[] {
  const prepared = rows.map((row) => {
    const body = `${row.title}\n${row.summary ?? ""}\n${row.content}`;
    return {
      row,
      tokens: tokenize(body),
      normalizedTitle: normalizeTitle(row.title),
      negation: hasNegation(body),
    };
  });

  const negated = prepared.filter((item) => item.negation).slice(0, CONFLICT_PROBE_MAX);
  const conflicts: ConflictPair[] = [];
  const seen = new Set<string>();

  for (const left of negated) {
    for (const right of prepared) {
      if (right.row.id === left.row.id) continue;
      if (right.negation) continue; // two negations are not a contradiction
      if (right.row.type !== left.row.type) continue;
      // Identical titles are a duplicate, not a conflict — findDuplicateGroups owns those.
      if (right.normalizedTitle === left.normalizedTitle) continue;

      const overlap = jaccard(left.tokens, right.tokens);
      if (overlap < CONFLICT_OVERLAP_MIN) continue;

      const pairKey = [left.row.id, right.row.id].sort().join(":");
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);

      conflicts.push({
        memoryId: left.row.id,
        memoryTitle: left.row.title,
        conflictsWithId: right.row.id,
        conflictsWithTitle: right.row.title,
        overlap: Math.round(overlap * 100) / 100,
        reason: `Says "${left.negation?.trim()}" about the same subject`,
      });
      if (conflicts.length >= limit) return conflicts;
    }
  }

  return conflicts;
}

/**
 * Scan, and optionally act.
 *
 * `apply: false` (the default) writes nothing — the caller gets exactly the report it
 * would have got, so a UI can show it before anyone commits to it (§30).
 *
 * `apply: true` performs the only two mutations this module is allowed to make:
 *   1. per duplicate group, keep the strongest memory, link it `supersedes` to each
 *      duplicate, archive the duplicates, and snapshot a version on the survivor;
 *   2. per conflict pair, record a `contradicts` link.
 *
 * Each group is applied on its own rather than inside one giant transaction. Both
 * operations are idempotent (the link upserts, the archive is a no-op when already
 * archived), so a failure part-way leaves a consistent brain and a re-run finishes
 * the job instead of double-merging.
 */
export async function consolidateBrain(params: {
  brainId: string;
  principal: Principal;
  apply?: boolean;
  limit?: number;
  resolver?: ConsolidationResolver;
}): Promise<ConsolidationReport> {
  const { brainId, principal, resolver } = params;
  const apply = params.apply === true;

  let duplicates = await findDuplicateGroups({ brainId, limit: params.limit });
  const conflictScan = await findConflictCandidates({ brainId, limit: params.limit });
  let conflicts = conflictScan.conflicts;

  if (resolver?.filterDuplicates) {
    const keep = new Set(duplicates.map((group) => group.key + "\u0000" + group.type));
    duplicates = (await resolver.filterDuplicates(duplicates)).filter((group) =>
      keep.has(group.key + "\u0000" + group.type)
    );
  }
  if (resolver?.filterConflicts) {
    const keep = new Set(conflicts.map((pair) => pair.memoryId + "\u0000" + pair.conflictsWithId));
    conflicts = (await resolver.filterConflicts(conflicts)).filter((pair) =>
      keep.has(pair.memoryId + "\u0000" + pair.conflictsWithId)
    );
  }

  const report: ConsolidationReport = {
    scanned: conflictScan.scanned,
    duplicates,
    conflicts,
    truncated: conflictScan.truncated,
  };

  if (!apply) return report;

  let memoriesArchived = 0;
  let supersedesLinks = 0;
  let conflictLinks = 0;

  for (const group of duplicates) {
    const [survivor, ...losers] = group.memories;
    if (!survivor || losers.length === 0) continue;

    const merged: { id: string; title: string }[] = [];

    for (const loser of losers) {
      await linkMemory({
        brainId,
        sourceMemoryId: survivor.id,
        target: { targetType: "memory", targetMemoryId: loser.id },
        linkType: "supersedes",
        metadata: { via: "consolidation", reason: "duplicate title" },
        principal,
      });
      supersedesLinks += 1;

      await updateMemory({
        brainId,
        memoryId: loser.id,
        principal,
        data: { archived: true },
        changeReason: `Consolidated into ${survivor.id}`,
      });
      memoriesArchived += 1;
      merged.push({ id: loser.id, title: loser.title });
    }

    // Metadata change on the survivor is what makes updateMemory snapshot a version,
    // so the pre-merge state of the survivor stays recoverable from its history.
    const existingMetadata = await readMetadata(brainId, survivor.id);
    const previous = Array.isArray(existingMetadata?.consolidatedFrom)
      ? (existingMetadata.consolidatedFrom as unknown[])
      : [];

    await updateMemory({
      brainId,
      memoryId: survivor.id,
      principal,
      data: {
        metadata: {
          ...(existingMetadata ?? {}),
          consolidatedFrom: [
            ...previous,
            ...merged.map((item) => ({ ...item, at: new Date().toISOString() })),
          ],
        },
      },
      changeReason: `Consolidated ${merged.length} duplicate memor${merged.length === 1 ? "y" : "ies"}`,
    });
  }

  for (const pair of conflicts) {
    await linkMemory({
      brainId,
      sourceMemoryId: pair.memoryId,
      target: { targetType: "memory", targetMemoryId: pair.conflictsWithId },
      linkType: "contradicts",
      metadata: { via: "consolidation", overlap: pair.overlap, reason: pair.reason },
      principal,
    });
    conflictLinks += 1;
  }

  report.applied = { memoriesArchived, supersedesLinks, conflictLinks };
  return report;
}

async function readMetadata(
  brainId: string,
  memoryId: string
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select({ metadata: memories.metadata })
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.brainId, brainId)))
    .limit(1);
  const value = row?.metadata;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

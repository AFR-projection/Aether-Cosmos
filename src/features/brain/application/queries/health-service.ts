import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db as applicationDb } from "@/shared/infrastructure/db";
import * as schema from "@/shared/infrastructure/db/schema";
import { memories, memoryLinks, brainEntities, memoryDerivedLinks } from "@/shared/infrastructure/db/schema";
import {
  buildUndirectedGraph,
  computeDegrees,
  connectedComponents,
} from "@brain/domain/graph/algorithms";
import {
  CONSOLIDATION_SCAN_MAX,
  detectConflicts,
  type ConflictCandidate,
} from "@brain/application/commands/consolidation-service";

/**
 * Brain health analysis: quality metrics, knowledge gaps, and contradiction detection.
 *
 * Surfaces structural issues (orphans, weak links), quality signals (low confidence,
 * unconfirmed, stale), and contradictions (active memories with conflicting claims).
 * Everything is read-only — this is a diagnostic surface, not an auto-fix.
 */

export type BrainHealthMetrics = {
  brainId: string;
  totalMemories: number;
  activeMemories: number;
  archivedMemories: number;
  supersededMemories: number;
  staleDays: number;
  staleMemories: number;

  // Structural
  orphanMemories: number;
  weaklyConnectedMemories: number;
  isolatedClusters: number;

  // Derived connectivity (relate-v1). These EXPLAIN the orphan count, they do not
  // change it: `orphanMemories` still counts memories with no *explicit* (curated)
  // link, because that is the curation-debt signal review-service acts on. A memory
  // can be an explicit orphan and still be richly connected by derived similarity
  // edges — these three fields make that visible instead of contradictory.
  //
  //  - derivedConnectedMemories : active memories with >=1 applied derived edge.
  //  - orphanConnectedViaDerived: explicit orphans that DO have a derived edge —
  //    "uncurated but connected".
  //  - fullyIsolatedMemories    : orphans with neither an explicit nor a derived
  //    edge — the memories that are actually alone.
  derivedConnectedMemories: number;
  orphanConnectedViaDerived: number;
  fullyIsolatedMemories: number;

  // Quality
  lowConfidenceMemories: number;
  unconfirmedMemories: number;
  agentCreatedMemories: number;

  // Relationships
  totalLinks: number;
  totalEntities: number;
  avgLinksPerMemory: number;

  // Contradictions
  contradictionCount: number;
};

export type HealthIssue = {
  type: "orphan" | "weak_link" | "low_confidence" | "unconfirmed" | "stale" | "contradiction";
  severity: "low" | "medium" | "high";
  memoryId: string;
  memoryTitle: string;
  reason: string;
  /** For contradictions: the conflicting memory. */
  conflictsWith?: { id: string; title: string };
};

export type BrainHealthReport = {
  metrics: BrainHealthMetrics;
  issues: HealthIssue[];
};

/**
 * One contradiction, whichever way it was found. `source` records that: a `link`
 * pair was recorded deliberately, a `detected` pair is this scan's own reading of
 * the text and carries the overlap that produced it.
 */
export type ContradictionPair = {
  memoryId: string;
  relatedMemoryId: string;
  reason: string;
  source: "link" | "detected";
  overlap?: number;
};

/** High first: `maxIssues` must never let low-severity noise crowd out a contradiction. */
const SEVERITY_RANK: Record<HealthIssue["severity"], number> = { high: 0, medium: 1, low: 2 };

/**
 * Analyze brain health and surface issues.
 *
 * @param db - Database connection
 * @param brainId - Brain to analyze
 * @param staleDays - Threshold for staleness (default 180)
 * @param lowConfidenceThreshold - Confidence below this is flagged (default 0.5)
 * @param maxIssues - Maximum issues to return (default 50)
 */
export async function analyzeBrainHealth(
  db: PostgresJsDatabase<typeof schema>,
  brainId: string,
  staleDays = 180,
  lowConfidenceThreshold = 0.5,
  maxIssues = 50
): Promise<BrainHealthReport> {
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleDays * 86_400_000);

  // Metrics: counts.
  const [totalCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt)));

  const [activeCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active")
      )
    );

  const [archivedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt), sql`archived_at IS NOT NULL`));

  const [supersededCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        eq(memories.validityState, "superseded")
      )
    );

  const [staleCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active"),
        sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt})) < ${staleThreshold.toISOString()}::timestamptz`
      )
    );

  const [lowConfidenceCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active"),
        sql`${memories.confidence} < ${lowConfidenceThreshold}`
      )
    );

  const [unconfirmedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active"),
        eq(memories.confirmationCount, 0)
      )
    );

  const [agentCreatedCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        sql`${memories.createdByAgent} IS NOT NULL`
      )
    );

  const [linkCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(memoryLinks)
    .where(eq(memoryLinks.brainId, brainId));

  const [entityCount] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(brainEntities)
    .where(eq(brainEntities.brainId, brainId));

  const avgLinksPerMemory = totalCount.count > 0 ? linkCount.count / totalCount.count : 0;

  // Structural issues: orphans and weakly connected.
  const activeMemories = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active")
      )
    );

  const activeMemoryIds = activeMemories.map((m) => m.id);

  const links = await db
    .select({
      sourceMemoryId: memoryLinks.sourceMemoryId,
      targetMemoryId: memoryLinks.targetMemoryId,
      linkType: memoryLinks.linkType,
    })
    .from(memoryLinks)
    .where(and(eq(memoryLinks.brainId, brainId), eq(memoryLinks.targetType, "memory")));

  const edges = links
    .filter((link) => link.targetMemoryId !== null)
    .map((link) => ({
      source: link.sourceMemoryId,
      target: link.targetMemoryId!,
      type: link.linkType,
      weight: 1.0,
    }));

  const graph = buildUndirectedGraph(edges);

  // Degrees are read against the ACTIVE memory list, not against the graph's node
  // set: a memory with no link rows never appears in the adjacency list at all, so
  // asking the graph for its orphans would silently miss exactly the memories that
  // are most isolated. Absent node ⇒ degree 0.
  const degrees = computeDegrees(graph);
  const degreeOf = (memoryId: string) => degrees.get(memoryId)?.degree ?? 0;
  const orphanIds = activeMemoryIds.filter((id) => degreeOf(id) === 0);
  const weakIds = activeMemoryIds.filter((id) => degreeOf(id) === 1);

  // Derived connectivity, read from the SEPARATE memory_derived_links table (relate-v1).
  // Only `applied` edges count — a `suggested` edge is a proposal, not a connection.
  // This never touches the explicit orphan computation above; it only annotates it, so
  // the health report can say "orphan, but connected by similarity" instead of looking
  // like it contradicts brain_get_related.
  const activeIdSetForDerived = new Set(activeMemoryIds);
  const derivedRows = await db
    .select({
      source: memoryDerivedLinks.sourceMemoryId,
      target: memoryDerivedLinks.targetMemoryId,
    })
    .from(memoryDerivedLinks)
    .where(and(eq(memoryDerivedLinks.brainId, brainId), eq(memoryDerivedLinks.status, "applied")));

  const derivedConnectedIds = new Set<string>();
  for (const row of derivedRows) {
    if (activeIdSetForDerived.has(row.source)) derivedConnectedIds.add(row.source);
    if (activeIdSetForDerived.has(row.target)) derivedConnectedIds.add(row.target);
  }
  const orphanConnectedViaDerived = orphanIds.filter((id) => derivedConnectedIds.has(id)).length;
  const fullyIsolatedMemories = orphanIds.length - orphanConnectedViaDerived;

  // Isolated clusters: connected components across the active memories. Every
  // orphan is a component of its own, so a brain with no links at all reports one
  // cluster per memory — which is the honest reading of "nothing is connected".
  const componentOf = connectedComponents(graph);
  const activeIdSet = new Set(activeMemoryIds);
  const connectedComponentIds = new Set<string>();
  for (const [nodeId, representative] of componentOf) {
    if (activeIdSet.has(nodeId) && degreeOf(nodeId) > 0) {
      connectedComponentIds.add(representative);
    }
  }
  const isolatedClusters = connectedComponentIds.size + orphanIds.length;

  // Contradictions come from two places, and both are needed:
  //
  //  1. `contradicts` link rows — pairs a user or the consolidation pass has already
  //     recorded. Durable, and reported until someone resolves them.
  //  2. A fresh scan through the consolidation service's own `detectConflicts`, so a
  //     brain that has never run consolidation still sees its contradictions. The
  //     detector is REUSED rather than reimplemented: one definition of "conflict"
  //     for the whole system.
  //
  // Detection here is read-only and bounded by CONSOLIDATION_SCAN_MAX. It never
  // writes a link and never resolves anything — resolution stays an explicit
  // decision (see review-service).
  const contradictionLinks = await db
    .select({
      sourceMemoryId: memoryLinks.sourceMemoryId,
      targetMemoryId: memoryLinks.targetMemoryId,
    })
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.brainId, brainId),
        eq(memoryLinks.linkType, "contradicts"),
        eq(memoryLinks.targetType, "memory")
      )
    );

  const conflictCandidates: ConflictCandidate[] = await db
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
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        isNull(memories.archivedAt),
        eq(memories.validityState, "active")
      )
    )
    .orderBy(desc(memories.updatedAt))
    .limit(CONSOLIDATION_SCAN_MAX);

  const pairKeyOf = (a: string, b: string) => [a, b].sort().join(":");
  const contradictionPairs: ContradictionPair[] = [];
  const seenPairs = new Set<string>();

  for (const link of contradictionLinks) {
    if (!link.targetMemoryId) continue;
    const key = pairKeyOf(link.sourceMemoryId, link.targetMemoryId);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    contradictionPairs.push({
      memoryId: link.sourceMemoryId,
      relatedMemoryId: link.targetMemoryId,
      reason: "Recorded as contradicting another active memory.",
      source: "link",
    });
  }

  for (const pair of detectConflicts(conflictCandidates, maxIssues)) {
    const key = pairKeyOf(pair.memoryId, pair.conflictsWithId);
    if (seenPairs.has(key)) continue; // already recorded as a link
    seenPairs.add(key);
    contradictionPairs.push({
      memoryId: pair.memoryId,
      relatedMemoryId: pair.conflictsWithId,
      reason: `${pair.reason} (${Math.round(pair.overlap * 100)}% word overlap).`,
      source: "detected",
      overlap: pair.overlap,
    });
  }

  // Titles are resolved before anything is counted. A pair naming a memory this brain
  // cannot see — deleted, or belonging to someone else — is not a contradiction it can
  // report, so it must not inflate the metric either: the number in `metrics` and the
  // issues in the list describe the same set of pairs.
  const resolvedPairs: Array<ContradictionPair & { title: string; relatedTitle: string }> = [];

  if (contradictionPairs.length > 0) {
    const involvedIds = Array.from(
      new Set(contradictionPairs.flatMap((pair) => [pair.memoryId, pair.relatedMemoryId]))
    );
    const involved = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt),
          inArray(memories.id, involvedIds)
        )
      );

    const titleOf = new Map(involved.map((row) => [row.id, row.title]));

    for (const pair of contradictionPairs) {
      const title = titleOf.get(pair.memoryId);
      const relatedTitle = titleOf.get(pair.relatedMemoryId);
      if (!title || !relatedTitle) continue;
      resolvedPairs.push({ ...pair, title, relatedTitle });
    }
  }

  const contradictionCount = resolvedPairs.length;

  // Build issues list.
  const issues: HealthIssue[] = [];

  // Contradictions first: they are the only "high" severity issue, and building them
  // last would let dozens of low-severity orphans consume the whole maxIssues budget.
  for (const pair of resolvedPairs) {
    if (issues.length >= maxIssues) break;
    issues.push({
      type: "contradiction",
      severity: "high",
      memoryId: pair.memoryId,
      memoryTitle: pair.title,
      reason: pair.reason,
      conflictsWith: { id: pair.relatedMemoryId, title: pair.relatedTitle },
    });
  }

  // Orphans.
  if (orphanIds.length > 0) {
    const orphanMemories = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.brainId, brainId), inArray(memories.id, orphanIds)))
      // A capped LIMIT with no ORDER BY hands back a nondeterministic subset: when a
      // brain has more orphans than the issue budget, two identical calls could list
      // different examples. `id` is unique, so it makes the truncation stable. The
      // metric (`orphanMemories`) already counts every orphan; only the sample shown
      // here is bounded.
      .orderBy(asc(memories.id))
      .limit(maxIssues);

    for (const mem of orphanMemories) {
      issues.push({
        type: "orphan",
        severity: "medium",
        memoryId: mem.id,
        memoryTitle: mem.title,
        reason: derivedConnectedIds.has(mem.id)
          ? "No explicit (curated) links — connected only by derived similarity."
          : "No explicit or derived connections; fully isolated.",
      });
    }
  }

  // Weak links.
  if (weakIds.length > 0 && issues.length < maxIssues) {
    const weakMemories = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(and(eq(memories.brainId, brainId), inArray(memories.id, weakIds)))
      // Stable truncation, same reasoning as the orphan sample above.
      .orderBy(asc(memories.id))
      .limit(maxIssues - issues.length);

    for (const mem of weakMemories) {
      issues.push({
        type: "weak_link",
        severity: "low",
        memoryId: mem.id,
        memoryTitle: mem.title,
        reason: "Only one connection; barely integrated.",
      });
    }
  }

  // Low confidence.
  if (issues.length < maxIssues) {
    const lowConfMemories = await db
      .select({ id: memories.id, title: memories.title, confidence: memories.confidence })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt),
          isNull(memories.archivedAt),
          eq(memories.validityState, "active"),
          sql`${memories.confidence} < ${lowConfidenceThreshold}`
        )
      )
      // Stable truncation, same reasoning as the orphan sample above.
      .orderBy(asc(memories.id))
      .limit(maxIssues - issues.length);

    for (const mem of lowConfMemories) {
      issues.push({
        type: "low_confidence",
        severity: "medium",
        memoryId: mem.id,
        memoryTitle: mem.title,
        reason: `Confidence ${mem.confidence.toFixed(2)} below threshold ${lowConfidenceThreshold}.`,
      });
    }
  }

  // Unconfirmed.
  if (issues.length < maxIssues) {
    const unconfMemories = await db
      .select({ id: memories.id, title: memories.title })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt),
          isNull(memories.archivedAt),
          eq(memories.validityState, "active"),
          eq(memories.confirmationCount, 0)
        )
      )
      // Stable truncation, same reasoning as the orphan sample above.
      .orderBy(asc(memories.id))
      .limit(maxIssues - issues.length);

    for (const mem of unconfMemories) {
      issues.push({
        type: "unconfirmed",
        severity: "low",
        memoryId: mem.id,
        memoryTitle: mem.title,
        reason: "Never confirmed by user or agent.",
      });
    }
  }

  // Stale.
  if (issues.length < maxIssues) {
    const staleMemories = await db
      .select({ id: memories.id, title: memories.title, updatedAt: memories.updatedAt })
      .from(memories)
      .where(
        and(
          eq(memories.brainId, brainId),
          isNull(memories.deletedAt),
          isNull(memories.archivedAt),
          eq(memories.validityState, "active"),
          sql`GREATEST(${memories.updatedAt}, COALESCE(${memories.lastAccessedAt}, ${memories.updatedAt})) < ${staleThreshold.toISOString()}::timestamptz`
        )
      )
      // Stable truncation, same reasoning as the orphan sample above.
      .orderBy(asc(memories.id))
      .limit(maxIssues - issues.length);

    for (const mem of staleMemories) {
      const daysSinceUpdate = Math.floor((now.getTime() - mem.updatedAt.getTime()) / 86_400_000);
      issues.push({
        type: "stale",
        severity: "low",
        memoryId: mem.id,
        memoryTitle: mem.title,
        reason: `Not accessed in ${daysSinceUpdate} days.`,
      });
    }
  }

  // Stable sort by severity so a truncated list keeps the most serious issues.
  const ordered = issues
    .map((issue, index) => ({ issue, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.issue.severity] - SEVERITY_RANK[b.issue.severity] || a.index - b.index
    )
    .map((entry) => entry.issue);

  return {
    metrics: {
      brainId,
      totalMemories: totalCount.count,
      activeMemories: activeCount.count,
      archivedMemories: archivedCount.count,
      supersededMemories: supersededCount.count,
      staleDays,
      staleMemories: staleCount.count,
      orphanMemories: orphanIds.length,
      weaklyConnectedMemories: weakIds.length,
      isolatedClusters,
      derivedConnectedMemories: derivedConnectedIds.size,
      orphanConnectedViaDerived,
      fullyIsolatedMemories,
      lowConfidenceMemories: lowConfidenceCount.count,
      unconfirmedMemories: unconfirmedCount.count,
      agentCreatedMemories: agentCreatedCount.count,
      totalLinks: linkCount.count,
      totalEntities: entityCount.count,
      avgLinksPerMemory: parseFloat(avgLinksPerMemory.toFixed(2)),
      contradictionCount,
    },
    issues: ordered.slice(0, maxIssues),
  };
}

/**
 * Service wrapper using the application database connection.
 */
export function getBrainHealth(
  brainId: string,
  staleDays?: number,
  lowConfidenceThreshold?: number,
  maxIssues?: number
): Promise<BrainHealthReport> {
  return analyzeBrainHealth(applicationDb, brainId, staleDays, lowConfidenceThreshold, maxIssues);
}

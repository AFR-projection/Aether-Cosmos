import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brains, brainAccess, memories, users } from "@/lib/db/schema";
import { rememberMemory } from "./remember";
import { updateMemory } from "./memory-service";
import { enrichMemory } from "./enrich/enrich-service";
import { linkMemory } from "./link-service";
import { recallBrainContext } from "./recall";
import { buildBrainContext } from "./context-engine";
import { findBrainMemoryPath } from "./graph/path-service";
import { getBrainRelatedMemories } from "./graph/related-service";
import { getMemoryTimeline } from "./temporal-service";
import { getMemoryProvenance } from "./provenance-service";
import { getBrainHealth } from "./health-service";

/**
 * End-to-end workflows across the whole Brain stack:
 * remember → recall → context → path → related → timeline → provenance → health.
 *
 * These are the only tests in the suite that need a real database: they exist to
 * prove the services compose against live Postgres (FKs, check constraints,
 * triggers, tsvector), which a fake query builder cannot show. Every other Brain
 * test is DB-free and always runs.
 *
 * Gated on DATABASE_URL, so `vitest run` stays green on a machine without a
 * database. On a machine with one, run:
 *
 *   DATABASE_URL=postgres://... npx vitest run lib/brain/integration.test.ts
 */

const DATABASE_AVAILABLE = Boolean(process.env.DATABASE_URL);

// These tests hit live Postgres — several round trips per test, plus inline
// enrichment transactions — which comfortably exceeds vitest's 5s default. Match
// the timeout the other DB-gated suites use so a real run does not flake.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const principalOf = (userId: string) => ({ userId, agentId: null });

describe.skipIf(!DATABASE_AVAILABLE)("Second Brain integration (requires DATABASE_URL)", () => {
  let testBrainId: string;
  let testUserId: string;

  beforeEach(async () => {
    // A real owner row: brains.ownerUserId is a FK to users.id.
    const [user] = await db
      .insert(users)
      .values({
        username: `brain-integration-${crypto.randomUUID()}`,
        passwordHash: "integration-test-not-a-real-hash",
      })
      .returning();

    testUserId = user.id;

    const [brain] = await db
      .insert(brains)
      .values({ name: "Integration Test Brain", ownerUserId: testUserId })
      .returning();

    testBrainId = brain.id;

    await db.insert(brainAccess).values({
      brainId: testBrainId,
      principalType: "user",
      principalId: testUserId,
      role: "owner",
    });
  });

  afterEach(async () => {
    // Brain delete cascades memories, links, access rows; user delete follows.
    if (testBrainId) await db.delete(brains).where(eq(brains.id, testBrainId));
    if (testUserId) await db.delete(users).where(eq(users.id, testUserId));
  });

  it("remember → recall → context → path → related", async () => {
    const react = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "React is a JavaScript library for building user interfaces",
        content:
          "React is a JavaScript library for building user interfaces. It renders components and manages state updates.",
        type: "knowledge",
        importance: 0.8,
        confidence: 0.9,
        tags: ["react", "javascript", "frontend"],
      },
    });

    const next = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Next.js is a React framework for production",
        content:
          "Next.js is a React framework providing server-side rendering, static generation and route handlers.",
        type: "knowledge",
        importance: 0.7,
        confidence: 0.85,
        tags: ["nextjs", "react", "framework"],
      },
    });

    const typescript = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "TypeScript adds static typing to JavaScript",
        content: "TypeScript is a typed superset of JavaScript that compiles to plain JavaScript.",
        type: "knowledge",
        importance: 0.75,
        confidence: 0.9,
        tags: ["typescript", "javascript"],
      },
    });

    // Enrichment is what the worker runs asynchronously in production
    // (CREATE → enrich → relate). It extracts entities — React, Next.js and
    // TypeScript are all in the extractor lexicon — and writes the mention spans the
    // entity and graph retrieval legs depend on. Run it inline so this test
    // exercises the real remember → enrich → retrieve chain: a natural-language task
    // like the one below has no entities to resolve without it, and the lexical leg
    // AND-matches every content word, so a framing word such as "relate" (present in
    // no memory) would otherwise defeat the match and return nothing.
    await enrichMemory(db, { brainId: testBrainId, memoryId: react.memory.id });
    await enrichMemory(db, { brainId: testBrainId, memoryId: next.memory.id });
    await enrichMemory(db, { brainId: testBrainId, memoryId: typescript.memory.id });

    // Explicit, evidence-carrying links — never inferred from a shared word.
    await linkMemory({
      brainId: testBrainId,
      sourceMemoryId: next.memory.id,
      target: { targetType: "memory", targetMemoryId: react.memory.id },
      linkType: "built_on",
      principal: principalOf(testUserId),
    });

    await linkMemory({
      brainId: testBrainId,
      sourceMemoryId: typescript.memory.id,
      target: { targetType: "memory", targetMemoryId: react.memory.id },
      linkType: "works_with",
      principal: principalOf(testUserId),
    });

    // Recall: the brain-wide package used by the app surfaces.
    const recall = await recallBrainContext({
      brainId: testBrainId,
      query: "React framework for building apps",
    });

    const recalledIds = [...recall.relevant, ...recall.important, ...recall.recent].map((m) => m.id);
    expect(recalledIds).toContain(react.memory.id);
    expect(recall.contextText.length).toBeGreaterThan(0);

    // Context engine: the token-bounded agent primitive.
    const context = await buildBrainContext({
      brainId: testBrainId,
      task: "explain how React and Next.js relate",
      tokenBudget: 2_000,
      maxMemories: 10,
      includeGraph: true,
      includeProvenance: true,
    });

    expect(context.memories.length).toBeGreaterThan(0);
    // The hard invariant: never over the budget the caller asked for.
    expect(context.tokensUsed).toBeLessThanOrEqual(context.usableBudget);
    expect(context.usableBudget).toBeLessThanOrEqual(context.tokenBudget);
    expect(context.memories.map((m) => m.id)).toContain(react.memory.id);
    // Graph edges in the package only reference selected memories (no dangling).
    const selectedIds = new Set(context.memories.map((m) => m.id));
    for (const edge of context.graph?.edges ?? []) {
      expect(selectedIds.has(edge.sourceId)).toBe(true);
      expect(selectedIds.has(edge.targetId)).toBe(true);
    }

    // Path: explainable hops, not bare ids.
    const path = await findBrainMemoryPath(testBrainId, next.memory.id, react.memory.id, 5);

    expect(path.found).toBe(true);
    expect(path.path.length).toBeGreaterThan(0);
    expect(path.path[0].source.id).toBe(next.memory.id);
    expect(path.path[path.path.length - 1].target.id).toBe(react.memory.id);
    expect(path.path[0].relationshipType).toBe("built_on");

    // Related: multi-signal, every row carrying a reason.
    const related = await getBrainRelatedMemories(testBrainId, react.memory.id, 10, 2);

    expect(related.length).toBeGreaterThan(0);
    expect(related.map((r) => r.id)).toContain(next.memory.id);
    for (const row of related) {
      expect(row.reason).toBeTruthy();
      expect(row.id).not.toBe(react.memory.id);
    }
  });

  it("create → update → timeline → provenance", async () => {
    const created = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "API design guidance for this project",
        content: "REST endpoints should use correct HTTP methods and status codes.",
        type: "knowledge",
        importance: 0.7,
        confidence: 0.8,
        tags: ["api", "rest"],
      },
    });

    await updateMemory({
      brainId: testBrainId,
      memoryId: created.memory.id,
      principal: principalOf(testUserId),
      data: {
        content:
          "REST endpoints should use correct HTTP methods, status codes and cursor pagination.",
        confidence: 0.9,
      },
      changeReason: "Added pagination guidance",
    });

    const timeline = await getMemoryTimeline(testBrainId, created.memory.id);

    expect(timeline).not.toBeNull();
    expect(timeline!.events.length).toBeGreaterThanOrEqual(2);

    const createEvent = timeline!.events.find((e) => e.eventType === "created");
    const updateEvent = timeline!.events.find((e) => e.eventType === "updated");

    expect(createEvent).toBeTruthy();
    expect(updateEvent).toBeTruthy();
    expect(updateEvent!.changeReason).toBe("Added pagination guidance");
    // Events are chronological.
    const stamps = timeline!.events.map((e) => e.timestamp.getTime());
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);

    const provenance = await getMemoryProvenance(testBrainId, created.memory.id);

    expect(provenance).not.toBeNull();
    expect(provenance!.createdBy).toBe("user");
    expect(provenance!.createdByUserId).toBe(testUserId);
    expect(provenance!.versionCount).toBeGreaterThanOrEqual(1);
    expect(provenance!.confidence).toBeCloseTo(0.9, 5);
    expect(provenance!.lastChangeReason).toBe("Added pagination guidance");
    expect(provenance!.validityState).toBe("active");
  });

  it("health: orphans, low confidence and weak links are surfaced, never auto-fixed", async () => {
    const wellConnected = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Documented upload endpoint",
        content: "The upload endpoint is documented and covered by tests.",
        type: "knowledge",
        importance: 0.9,
        confidence: 0.95,
        tags: ["api"],
      },
    });

    await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Isolated fact with no relationships",
        content: "This memory is deliberately unconnected to anything else.",
        type: "fact",
        importance: 0.5,
        confidence: 0.6,
        tags: ["isolated"],
      },
    });

    await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Uncertain observation about queue throughput",
        content: "Throughput might be limited by the worker concurrency, unverified.",
        type: "observation",
        importance: 0.4,
        confidence: 0.3,
        tags: ["uncertain"],
      },
    });

    const weak = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Single-link fact about the upload endpoint",
        content: "This fact has exactly one relationship.",
        type: "fact",
        importance: 0.5,
        confidence: 0.7,
        tags: ["weak"],
      },
    });

    await linkMemory({
      brainId: testBrainId,
      sourceMemoryId: weak.memory.id,
      target: { targetType: "memory", targetMemoryId: wellConnected.memory.id },
      linkType: "related_to",
      principal: principalOf(testUserId),
    });

    const health = await getBrainHealth(testBrainId, 180, 0.5, 50);

    expect(health.metrics.totalMemories).toBe(4);
    expect(health.metrics.activeMemories).toBe(4);
    expect(health.metrics.totalLinks).toBeGreaterThanOrEqual(1);
    // Orphans stay visible as knowledge gaps.
    expect(health.metrics.orphanMemories).toBeGreaterThan(0);
    expect(health.metrics.lowConfidenceMemories).toBeGreaterThan(0);
    expect(health.metrics.isolatedClusters).toBeGreaterThanOrEqual(1);

    const orphanIssue = health.issues.find((i) => i.type === "orphan");
    const lowConfIssue = health.issues.find((i) => i.type === "low_confidence");
    const weakIssue = health.issues.find((i) => i.type === "weak_link");

    expect(orphanIssue).toBeTruthy();
    expect(lowConfIssue).toBeTruthy();
    expect(weakIssue).toBeTruthy();
    expect(orphanIssue!.severity).toBe("medium");
    expect(lowConfIssue!.severity).toBe("medium");
    expect(weakIssue!.severity).toBe("low");
    for (const issue of health.issues) expect(issue.reason).toBeTruthy();

    // Reporting must not mutate anything: still four active memories.
    const after = await getBrainHealth(testBrainId, 180, 0.5, 50);
    expect(after.metrics.activeMemories).toBe(4);
  });

  it("supersession is reflected in timeline and provenance both ways", async () => {
    const original = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Old async pattern for this codebase",
        content: "Use callbacks for asynchronous work.",
        type: "knowledge",
        importance: 0.7,
        confidence: 0.8,
        tags: ["async"],
      },
    });

    const replacement = await rememberMemory({
      brainId: testBrainId,
      principal: principalOf(testUserId),
      data: {
        title: "Current async pattern for this codebase",
        content: "Use promises and async/await for asynchronous work.",
        type: "knowledge",
        importance: 0.8,
        confidence: 0.95,
        tags: ["async"],
      },
    });

    // No service writes supersession yet, so the state is set directly here.
    // (Tracked as a known gap: supersede-service is not implemented.)
    await db
      .update(memories)
      .set({ validityState: "superseded", supersededById: replacement.memory.id })
      .where(eq(memories.id, original.memory.id));

    await linkMemory({
      brainId: testBrainId,
      sourceMemoryId: replacement.memory.id,
      target: { targetType: "memory", targetMemoryId: original.memory.id },
      linkType: "supersedes",
      principal: principalOf(testUserId),
    });

    const timeline = await getMemoryTimeline(testBrainId, original.memory.id);
    expect(timeline).not.toBeNull();
    const supersededEvent = timeline!.events.find((e) => e.eventType === "superseded");
    expect(supersededEvent).toBeTruthy();
    expect(supersededEvent!.supersededBy!.id).toBe(replacement.memory.id);

    const originalProvenance = await getMemoryProvenance(testBrainId, original.memory.id);
    expect(originalProvenance).not.toBeNull();
    expect(originalProvenance!.validityState).toBe("superseded");
    expect(originalProvenance!.supersededBy!.id).toBe(replacement.memory.id);

    const replacementProvenance = await getMemoryProvenance(testBrainId, replacement.memory.id);
    expect(replacementProvenance).not.toBeNull();
    expect(replacementProvenance!.supersedes.map((m) => m.id)).toContain(original.memory.id);
  });
});

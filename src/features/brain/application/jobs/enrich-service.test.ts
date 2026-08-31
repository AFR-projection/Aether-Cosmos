import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { EXTRACTOR_VERSION } from "./extract";
import {
  ENRICHMENT_ERROR_MAX_CHARS,
  ENRICHMENT_VERSION,
  ENRICH_SWEEP_LIMIT,
  ENRICH_SWEEP_MAX,
  KNOWN_ENTITY_LIMIT,
  MENTION_LINK_TYPE,
  memoryContentHash,
  sanitizeEnrichmentError,
} from "./enrich-service";

/**
 * Enrichment is the one pipeline that writes graph rows on its own, so its tests
 * are about two properties: the idempotency key is exact (a re-run must be able to
 * prove nothing changed), and the pipeline cannot leak memory text or clobber
 * curated data. The statement-level behaviour needs a live Postgres and is covered
 * by the integration suite; what is asserted here is everything that can be
 * verified deterministically — the hash, the error sanitizer, and the invariants
 * the SQL itself must keep.
 */

describe("memoryContentHash", () => {
  const base = { type: "fact", title: "Storage", summary: "Ringkas", content: "PostgreSQL." };

  it("is the documented digest, not an opaque one", () => {
    // Spelled out so a change to the recipe is a deliberate, visible edit: both
    // versions are inside the digest, which is what makes a smarter extractor
    // invalidate every hash instead of silently keeping stale graph rows.
    const expected = createHash("sha256")
      .update(
        [ENRICHMENT_VERSION, EXTRACTOR_VERSION, "fact", "Storage", "Ringkas", "PostgreSQL."].join(
          "\u0000"
        )
      )
      .digest("hex");
    expect(memoryContentHash(base)).toBe(expected);
  });

  it("is deterministic and hex", () => {
    expect(memoryContentHash(base)).toBe(memoryContentHash({ ...base }));
    expect(memoryContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when any enrichable field changes", () => {
    const variants = [
      { ...base, type: "decision" },
      { ...base, title: "Storage " },
      { ...base, summary: "Lain" },
      { ...base, content: "Redis." },
    ];
    for (const variant of variants) {
      expect(memoryContentHash(variant)).not.toBe(memoryContentHash(base));
    }
  });

  it("treats a null summary and an empty summary as the same absence", () => {
    expect(memoryContentHash({ ...base, summary: null })).toBe(
      memoryContentHash({ ...base, summary: "" })
    );
  });

  it("cannot be collided by shifting text across a field boundary", () => {
    // The NUL separator is the whole point: without it "ab" + "c" and "a" + "bc"
    // would hash identically and an edit would look like a no-op to the pipeline.
    expect(memoryContentHash({ title: "ab", content: "c" })).not.toBe(
      memoryContentHash({ title: "a", content: "bc" })
    );
  });
});

describe("sanitizeEnrichmentError", () => {
  it("keeps only the first line of the message", () => {
    const error = new Error(
      'duplicate key value violates unique constraint\nDETAIL: Key (surface)=(rahasia gaji direktur) already exists.'
    );
    const reason = sanitizeEnrichmentError(error);
    expect(reason).toContain("duplicate key value");
    // enrichment_error is returned by the memory API, so nothing that could carry
    // a row value is allowed into it.
    expect(reason).not.toContain("rahasia");
    expect(reason).not.toContain("DETAIL");
  });

  it("never reads driver fields that carry row values", () => {
    const error = Object.assign(new Error("insert failed"), {
      detail: "Key (content)=(nomor kartu 4111 1111 1111 1111)",
      where: "PL/pgSQL function",
      query: "insert into memory_mentions ...",
    });
    const reason = sanitizeEnrichmentError(error);
    expect(reason).toBe("Error: insert failed");
    expect(reason).not.toContain("4111");
    expect(reason).not.toContain("insert into");
  });

  it("stays inside the column budget", () => {
    const reason = sanitizeEnrichmentError(new Error("x".repeat(5_000)));
    expect(reason.length).toBeLessThanOrEqual(ENRICHMENT_ERROR_MAX_CHARS);
  });

  it("degrades to a fixed string for a non-Error throw", () => {
    expect(sanitizeEnrichmentError("catatan rahasia")).toBe("unknown error");
    expect(sanitizeEnrichmentError(undefined)).toBe("unknown error");
    expect(sanitizeEnrichmentError({ message: "catatan rahasia" })).toBe("unknown error");
  });
});

describe("the SQL keeps enrichment's invariants", () => {
  const source = readFileSync("src/features/brain/application/jobs/enrich-service.ts", "utf8");
  const entityUpsert = source.slice(
    source.indexOf(".insert(brainEntities)"),
    source.indexOf(".returning({ id: brainEntities.id })")
  );

  it("asserts against a real region of the source", () => {
    expect(entityUpsert.length).toBeGreaterThan(200);
    expect(entityUpsert).toContain("onConflictDoUpdate");
  });

  it("never writes description or metadata on an entity node", () => {
    // graph-service.upsertEntity nulls both in its conflict clause. Enrichment runs
    // on every edit, so doing the same here would erase curated meaning silently.
    expect(entityUpsert).not.toMatch(/\bdescription\b/);
    expect(entityUpsert).not.toMatch(/\bmetadata\b/);
  });

  it("recomputes mention_count instead of incrementing it", () => {
    expect(source).toContain("SELECT count(*)::int FROM");
    expect(source).not.toMatch(/mentionCount:\s*sql`[^`]*\+\s*1/);
  });

  it("reclaims only the links it marked as derived", () => {
    expect(source).toContain("'derivedBy' IS NOT NULL");
    expect(source).toContain("derivedBy: ENRICHMENT_VERSION");
    // A blanket delete of every `mentions` link would take human-made links with it.
    expect(source).not.toMatch(
      /delete\(memoryLinks\)\s*\.where\(\s*eq\(memoryLinks\.sourceMemoryId/
    );
  });

  it("scopes every memory write by brain, never by id alone", () => {
    const statements = source.match(/\.update\(memories\)[\s\S]*?\.where\([^)]*\)/g) ?? [];
    expect(statements.length).toBeGreaterThanOrEqual(3);
    for (const statement of statements) {
      expect(statement).toContain(".where(scope)");
    }
  });

  it("does not bump memories.updatedAt, so a backfill cannot fake freshness", () => {
    const statements = source.match(/\.update\(memories\)[\s\S]*?\.where\(/g) ?? [];
    for (const statement of statements) expect(statement).not.toContain("updatedAt");
  });

  it("routes the failure path through the sanitizer", () => {
    expect(source).toContain("sanitizeEnrichmentError(error)");
    expect(source).toContain("enrichmentError: reason");
    expect(source).not.toMatch(/enrichmentError:\s*\(?(String\()?error/);
  });

  it("keeps every read and every loop bounded", () => {
    expect(ENRICH_SWEEP_LIMIT).toBeLessThanOrEqual(ENRICH_SWEEP_MAX);
    expect(KNOWN_ENTITY_LIMIT).toBeGreaterThan(0);
    expect(source).toContain("limit(KNOWN_ENTITY_LIMIT)");
    expect(MENTION_LINK_TYPE).toBe("mentions");
  });
});

describe("the write path asks for enrichment without depending on it", () => {
  const memoryService = readFileSync("src/features/brain/application/commands/memory-service.ts", "utf8");

  it("stamps the idempotency key when the memory is created", () => {
    expect(memoryService).toContain("contentHash: memoryContentHash(");
  });

  it("returns a memory to `pending` when its enrichable text changes", () => {
    expect(memoryService).toContain('patch.enrichmentStatus = "pending"');
    expect(memoryService).toContain("needsEnrichment = true");
  });

  it("never awaits the queue inside the write path", () => {
    // A memory write must not fail — or stall — because Redis is unreachable.
    expect(memoryService).toContain("void enqueueJob(");
    expect(memoryService).not.toMatch(/await enqueueJob\(\s*"enrich_/);
  });

  it("enqueues only after the transaction has committed", () => {
    const createMemory = memoryService.slice(
      memoryService.indexOf("export async function createMemory"),
      memoryService.indexOf("// ── read")
    );
    expect(createMemory).toContain("requestEnrichment(");
    expect(createMemory.indexOf("requestEnrichment(")).toBeGreaterThan(
      createMemory.indexOf("await db.transaction")
    );
  });
});

describe("the worker dispatch stays fail-closed", () => {
  const worker = readFileSync("workers/index.ts", "utf8");

  it("handles both enrichment job types", () => {
    expect(worker).toContain('case "enrich_memory"');
    expect(worker).toContain('case "enrich_brain"');
  });

  it("refuses a payload that does not name a brain", () => {
    // Enrichment scopes its statements by brain; a job missing the id must be a
    // no-op rather than a non-null assertion that reaches the database as `null`.
    expect(worker).toContain("if (data.brainId && data.memoryId)");
    expect(worker).not.toMatch(/runEnrich(Memory|Brain)\(data\.brainId!/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import * as schema from "@/shared/infrastructure/db/schema";
import { ingestCandidates, renderIngestReport } from "./ingest";

const MEMORY_TABLE = getTableName(schema.memories);
type PoolRow = {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  type: string;
  confidence: number;
  metadata: unknown;
};

let poolRows: PoolRow[] = [];
const reads: { table: string; where: unknown; limit: number | null }[] = [];

function selectChain() {
  const call = { table: "", where: null as unknown, limit: null as number | null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy: () => chain,
    limit(value: number) {
      call.limit = value;
      return chain;
    },
    then<T>(resolve: (value: PoolRow[]) => T) {
      reads.push(call);
      return Promise.resolve(call.table === MEMORY_TABLE ? poolRows : []).then(resolve);
    },
  };
  return chain;
}

function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
  };
  walk(node);
  return parts.join(" ");
}

vi.mock("@/shared/infrastructure/db", () => ({ db: { select: () => selectChain() } }));

const createMemory = vi.fn();
const updateMemory = vi.fn();
vi.mock("./memory-service", () => ({
  createMemory: (...args: unknown[]) => createMemory(...args),
  updateMemory: (...args: unknown[]) => updateMemory(...args),
}));

const BRAIN = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL = { userId: "user-1", agentId: "agent-1", agentName: "Claude" };

beforeEach(() => {
  poolRows = [];
  reads.length = 0;
  createMemory.mockReset();
  updateMemory.mockReset();
  createMemory.mockResolvedValue({ id: "memory-new" });
  updateMemory.mockResolvedValue({ id: "memory-existing" });
});

describe("conversation ingest pipeline", () => {
  it("spends the write budget on the strongest candidates first without extra reads", async () => {
    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        { content: "My project uses PostgreSQL 16 on the production server." },
        { content: "Always run `npm test` before every production deployment." },
      ],
      options: { maxWrites: 1 },
    });

    expect(report.results.map((item) => [item.type, item.disposition])).toEqual([
      ["instruction", "created"],
      ["fact", "skipped_write_budget"],
    ]);
    expect(reads).toHaveLength(1);
    expect(createMemory).toHaveBeenCalledOnce();
  });

  it("stops before the database for low salience, sampling, and importance", async () => {
    const lowSalience = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [{ content: "Thanks bro" }],
    });
    const sampled = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [{ content: "My project uses PostgreSQL 16 on the production server." }],
      options: { sampleRate: 0 },
    });
    const lowImportance = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [{ content: "My project uses PostgreSQL 16 on the production server." }],
      options: { minImportance: 1 },
    });

    expect(lowSalience.results[0]?.disposition).toBe("skipped_low_salience");
    expect(sampled.results[0]?.disposition).toBe("skipped_sampled_out");
    expect(lowImportance.results[0]?.disposition).toBe("skipped_low_importance");
    expect(reads).toHaveLength(0);
  });

  it("creates a memory with conversation provenance, project, and normalized tags", async () => {
    await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        {
          content: "My project uses PostgreSQL 16 on the production server.",
          role: "user",
          turnIndex: 7,
        },
      ],
      options: { sessionId: "session-7", projectId: PROJECT, tags: [" Work ", "work"] },
    });

    expect(createMemory).toHaveBeenCalledWith({
      brainId: BRAIN,
      principal: PRINCIPAL,
      data: expect.objectContaining({
        sourceType: "conversation",
        sourceId: "session-7",
        projectId: PROJECT,
        tags: ["work"],
        metadata: {
          ingest: expect.objectContaining({
            sessionId: "session-7",
            agent: "Claude",
            role: "user",
            turnIndex: 7,
            inferredType: "fact",
          }),
        },
      }),
    });
  });

  it("previews the same create decision without writing", async () => {
    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [{ content: "My project uses PostgreSQL 16 on the production server." }],
      options: { commit: false },
    });

    expect(report.committed).toBe(false);
    expect(report.results[0]?.disposition).toBe("created");
    expect(report.results[0]?.reason).toContain("Would be created");
    expect(createMemory).not.toHaveBeenCalled();
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("corroborates an already-contained duplicate without changing content", async () => {
    poolRows = [
      {
        id: "memory-existing",
        title: "Production database",
        content: "The production database is PostgreSQL 16.",
        summary: null,
        type: "fact",
        confidence: 0.6,
        metadata: { owner: "user" },
      },
    ];

    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        {
          title: "Production database",
          content: "My project production database is PostgreSQL 16.",
          importance: 0.8,
        },
      ],
    });

    expect(report.results[0]?.disposition).toBe("merged");
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "memory-existing",
        data: { confidence: 0.65 },
      })
    );
  });

  it("skips a duplicate whose confidence cannot rise further", async () => {
    poolRows = [
      {
        id: "memory-existing",
        title: "Production database",
        content: "The production database is PostgreSQL 16.",
        summary: null,
        type: "fact",
        confidence: 0.9,
        metadata: null,
      },
    ];

    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        {
          title: "Production database",
          content: "My project production database is PostgreSQL 16.",
          importance: 0.8,
        },
      ],
    });

    expect(report.results[0]?.disposition).toBe("skipped_duplicate");
    expect(updateMemory).not.toHaveBeenCalled();
  });

  it("appends non-contained duplicate material and preserves existing metadata", async () => {
    poolRows = [
      {
        id: "memory-existing",
        title: "Deploy procedure",
        content: "Deploy production with Docker on the VPS after tests pass and notify the team.",
        summary: null,
        type: "procedure",
        confidence: 0.6,
        metadata: { owner: "user", ingest: { mergeCount: 2, firstSession: "old" } },
      },
    ];

    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        {
          title: "Deploy procedure",
          content: "Always deploy production with Docker on the VPS after tests pass and verify health metrics.",
          type: "procedure",
          importance: 0.8,
        },
      ],
      options: { sessionId: "session-new" },
    });

    expect(report.results[0]?.disposition).toBe("merged");
    expect(updateMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        memoryId: "memory-existing",
        data: expect.objectContaining({
          content: expect.stringContaining("verify health metrics"),
          metadata: expect.objectContaining({
            owner: "user",
            ingest: expect.objectContaining({ mergeCount: 3, firstSession: "old" }),
          }),
        }),
      })
    );
  });

  it("limits duplicate search to live memories in the candidate project", async () => {
    await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [
        {
          content: "My project uses PostgreSQL 16 on the production server.",
          projectId: PROJECT,
        },
      ],
    });

    const predicate = describeSql(reads[0]?.where);
    expect(predicate).toContain("archived_at");
    expect(predicate).toContain(PROJECT);
  });

  it("renders explainable reports and warns about standing instructions", async () => {
    const report = await ingestCandidates({
      brainId: BRAIN,
      principal: PRINCIPAL,
      candidates: [{ content: "Always run `npm test` before every production deployment." }],
      options: { commit: false, sessionId: "preview-session" },
    });
    const text = renderIngestReport(report);

    expect(text).toContain("Ingest preview (nothing written)");
    expect(text).toContain("standing instruction");
    expect(text).toContain("Thresholds:");
    expect(text).toContain("preview-session");
  });
});

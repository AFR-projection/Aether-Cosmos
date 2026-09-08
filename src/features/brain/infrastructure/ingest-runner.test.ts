import { beforeEach, describe, expect, it, vi } from "vitest";

const ingestCandidates = vi.fn();
const candidatesFromTurns = vi.fn();
const logBrainAudit = vi.fn();
const invalidateBrainCache = vi.fn();
const publishToUser = vi.fn();

vi.mock("@brain/application/commands/ingest", () => ({
  ingestCandidates: (...args: unknown[]) => ingestCandidates(...args),
  candidatesFromTurns: (...args: unknown[]) => candidatesFromTurns(...args),
}));
vi.mock("@brain/infrastructure/audit", () => ({
  logBrainAudit: (...args: unknown[]) => logBrainAudit(...args),
}));
vi.mock("@brain/infrastructure/mcp/cache", () => ({
  invalidateBrainCache: (...args: unknown[]) => invalidateBrainCache(...args),
}));
vi.mock("@/shared/infrastructure/realtime/events", () => ({
  publishToUser: (...args: unknown[]) => publishToUser(...args),
}));

const { runBrainIngest } = await import("./ingest-runner");
const BRAIN = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = {
  type: "agent" as const,
  id: "agent-1",
  agentId: "agent-1",
  agentName: "Claude",
};

function report(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "session-1",
    committed: true,
    considered: 1,
    created: 0,
    merged: 0,
    skipped: 1,
    reviewNeeded: 0,
    thresholds: { minSalience: 0.45, minImportance: 0.45, sampleRate: 1, maxWrites: 5 },
    results: [],
    ...overrides,
  };
}

beforeEach(() => {
  ingestCandidates.mockReset().mockResolvedValue(report());
  candidatesFromTurns.mockReset().mockReturnValue([]);
  logBrainAudit.mockReset().mockResolvedValue(undefined);
  invalidateBrainCache.mockReset();
  publishToUser.mockReset().mockResolvedValue(undefined);
});

describe("runBrainIngest side effects", () => {
  it("audits a committed session end even when every candidate is skipped", async () => {
    await runBrainIngest({
      brainId: BRAIN,
      userId: "user-1",
      principal: PRINCIPAL,
      operation: "session.end",
      turns: [{ role: "user", text: "Thanks" }],
    });

    expect(logBrainAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "session.end",
        resourceId: "session-1",
        metadata: expect.objectContaining({ created: 0, merged: 0, skipped: 1 }),
      })
    );
    expect(invalidateBrainCache).not.toHaveBeenCalled();
    expect(publishToUser).not.toHaveBeenCalled();
  });

  it("does not audit or publish a preview", async () => {
    ingestCandidates.mockResolvedValue(report({ committed: false, created: 1, skipped: 0 }));

    await runBrainIngest({
      brainId: BRAIN,
      userId: "user-1",
      principal: PRINCIPAL,
      operation: "memory.ingest",
      candidates: [{ content: "Use PostgreSQL 16 in production." }],
      options: { commit: false },
    });

    expect(logBrainAudit).not.toHaveBeenCalled();
    expect(invalidateBrainCache).not.toHaveBeenCalled();
    expect(publishToUser).not.toHaveBeenCalled();
  });

  it("invalidates and publishes only concrete committed writes", async () => {
    ingestCandidates.mockResolvedValue(
      report({
        created: 1,
        merged: 1,
        skipped: 0,
        results: [
          { disposition: "created", memoryId: "memory-new", title: "Database" },
          { disposition: "merged", memoryId: "memory-old", title: "Deploy" },
        ],
      })
    );

    await runBrainIngest({
      brainId: BRAIN,
      userId: "user-1",
      principal: PRINCIPAL,
      operation: "memory.ingest",
      candidates: [{ content: "Use PostgreSQL 16 in production." }],
    });

    expect(invalidateBrainCache).toHaveBeenCalledWith(BRAIN);
    expect(logBrainAudit).toHaveBeenCalledOnce();
    expect(publishToUser).toHaveBeenCalledTimes(2);
    expect(publishToUser).toHaveBeenNthCalledWith(
      1,
      "user-1",
      expect.objectContaining({ type: "brain_memory_created", memoryId: "memory-new" })
    );
    expect(publishToUser).toHaveBeenNthCalledWith(
      2,
      "user-1",
      expect.objectContaining({ type: "brain_memory_updated", memoryId: "memory-old" })
    );
  });
});

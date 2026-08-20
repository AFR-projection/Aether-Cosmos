import { describe, expect, it } from "vitest";
import {
  detectConflicts,
  CONSOLIDATION_SCAN_MAX,
  type ConflictCandidate,
} from "./consolidation-service";

/**
 * §31 conflict detection. Only the pure pairwise pass is covered here — the two
 * queries in front of it need a database and belong to the integration layer.
 */

function memory(
  id: string,
  title: string,
  content: string,
  type: ConflictCandidate["type"] = "decision"
): ConflictCandidate {
  return { id, type, title, content, summary: null };
}

describe("detectConflicts", () => {
  it("pairs a negated statement with the positive one it contradicts", () => {
    const conflicts = detectConflicts([
      memory("a", "Deployment target", "We deploy the storage app to Vercel using the production branch"),
      memory("b", "Deployment moved", "We no longer deploy the storage app to Vercel using the production branch"),
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].memoryId).toBe("b"); // the negation is always the left side
    expect(conflicts[0].conflictsWithId).toBe("a");
    expect(conflicts[0].overlap).toBeGreaterThan(0.5);
    expect(conflicts[0].reason).toContain("no longer");
  });

  it("ignores memories of a different type", () => {
    const conflicts = detectConflicts([
      memory("a", "Deployment target", "We deploy the storage app to Vercel production", "decision"),
      memory("b", "Deployment moved", "We no longer deploy the storage app to Vercel production", "fact"),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("does not report two negations against each other", () => {
    const conflicts = detectConflicts([
      memory("a", "Old host", "We no longer deploy the storage app to Vercel production"),
      memory("b", "Old queue", "We no longer deploy the storage app to Vercel staging"),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("leaves identical titles to duplicate detection", () => {
    const conflicts = detectConflicts([
      memory("a", "Deployment target", "We deploy the storage app to Vercel production"),
      memory("b", "  deployment   TARGET ", "We no longer deploy the storage app to Vercel production"),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("requires real overlap, not just a negation somewhere in the brain", () => {
    const conflicts = detectConflicts([
      memory("a", "Database choice", "Postgres on Neon holds every memory row"),
      memory("b", "Icon policy", "Emoji are not allowed as interface icons anywhere"),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("never links a memory to itself", () => {
    const conflicts = detectConflicts([
      memory("a", "Deployment", "We no longer deploy the storage app to Vercel production"),
    ]);

    expect(conflicts).toEqual([]);
  });

  it("respects the reported limit", () => {
    const rows: ConflictCandidate[] = [
      memory("neg", "Hosting changed", "We no longer deploy the storage application to Vercel production"),
    ];
    for (let i = 0; i < 10; i += 1) {
      rows.push(memory(`pos-${i}`, `Hosting note ${i}`, "We deploy the storage application to Vercel production"));
    }

    expect(detectConflicts(rows, 3)).toHaveLength(3);
    expect(detectConflicts(rows, 50)).toHaveLength(10);
  });

  it("keeps each pair once even when both orderings would match", () => {
    const conflicts = detectConflicts([
      memory("a", "Queue driver", "BullMQ on Redis runs every background job for uploads"),
      memory("b", "Queue driver removed", "BullMQ on Redis is not used for background jobs for uploads"),
      memory("c", "Queue driver again", "BullMQ on Redis runs every background job for uploads today"),
    ]);

    const keys = conflicts.map((pair) => [pair.memoryId, pair.conflictsWithId].sort().join(":"));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("bounds the scan so a large brain cannot fan out without limit", () => {
    expect(CONSOLIDATION_SCAN_MAX).toBeLessThanOrEqual(500);
  });
});

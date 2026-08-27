/**
 * Tests for temporal edge detection
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { db } from "@/lib/db";
import {
  detectSequenceEdges,
  detectCoEditedEdges,
  detectBurstEdges,
  detectAllTemporalEdges,
  updateTemporalEdgesForMemory,
} from "./temporal-edges";
import { derivedLinkService } from "./derived-link-service";

describe("Temporal Edge Detection", () => {
  let testBrainId: string;
  let testUserId: string;

  beforeEach(async () => {
    // Create test user
    const userResult = await db.query(
      `INSERT INTO users (email, name, role)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [`temporal-test-${Date.now()}@example.com`, "Temporal Test", "user"]
    );
    testUserId = userResult.rows[0].id;

    // Create test brain
    const brainResult = await db.query(
      `INSERT INTO brains (name, user_id)
       VALUES ($1, $2)
       RETURNING id`,
      ["Temporal Test Brain", testUserId]
    );
    testBrainId = brainResult.rows[0].id;
  });

  afterEach(async () => {
    // Cleanup
    await db.query(`DELETE FROM memory_derived_links WHERE source_id IN (SELECT id FROM memories WHERE brain_id = $1)`, [testBrainId]);
    await db.query(`DELETE FROM memories WHERE brain_id = $1`, [testBrainId]);
    await db.query(`DELETE FROM brains WHERE id = $1`, [testBrainId]);
    await db.query(`DELETE FROM users WHERE id = $1`, [testUserId]);
  });

  describe("detectSequenceEdges", () => {
    it("should detect memories created in sequence", async () => {
      const now = new Date();

      // Create 3 memories: A, B (2 min later), C (4 min later)
      const memA = await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testBrainId, "First memory", now]
      );

      const memB = await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testBrainId, "Second memory", new Date(now.getTime() + 2 * 60 * 1000)]
      );

      const memC = await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testBrainId, "Third memory", new Date(now.getTime() + 4 * 60 * 1000)]
      );

      const edgesCreated = await detectSequenceEdges(testBrainId, {
        sequenceWindowMs: 5 * 60 * 1000,
      });

      expect(edgesCreated).toBe(2); // A→B, B→C

      const links = await db.query(
        `SELECT source_id, target_id, relationship_type
         FROM memory_derived_links
         WHERE source_id = ANY($1::uuid[])
         ORDER BY source_id`,
        [[memA.rows[0].id, memB.rows[0].id]]
      );

      expect(links.rows).toHaveLength(2);
      expect(links.rows[0].relationship_type).toBe("TEMPORAL_SEQUENCE");
      expect(links.rows[1].relationship_type).toBe("TEMPORAL_SEQUENCE");
    });

    it("should NOT create edges when gap exceeds window", async () => {
      const now = new Date();

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "First memory", now]
      );

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "Second memory", new Date(now.getTime() + 10 * 60 * 1000)]
      );

      const edgesCreated = await detectSequenceEdges(testBrainId, {
        sequenceWindowMs: 5 * 60 * 1000,
      });

      expect(edgesCreated).toBe(0);
    });
  });

  describe("detectCoEditedEdges", () => {
    it("should detect memories modified in same session", async () => {
      const now = new Date();
      const createTime = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago

      const memA = await db.query(
        `INSERT INTO memories (brain_id, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [testBrainId, "Memory A", createTime, now]
      );

      const memB = await db.query(
        `INSERT INTO memories (brain_id, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [testBrainId, "Memory B", createTime, new Date(now.getTime() + 3 * 60 * 1000)]
      );

      const edgesCreated = await detectCoEditedEdges(testBrainId, {
        coEditWindowMs: 10 * 60 * 1000,
      });

      expect(edgesCreated).toBe(1);

      const links = await db.query(
        `SELECT relationship_type
         FROM memory_derived_links
         WHERE source_id = $1 AND target_id = $2`,
        [memA.rows[0].id, memB.rows[0].id]
      );

      expect(links.rows[0].relationship_type).toBe("TEMPORAL_COEDITED");
    });

    it("should ignore memories never updated", async () => {
      const now = new Date();

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at, updated_at)
         VALUES ($1, $2, $3, $3)`,
        [testBrainId, "Never edited", now]
      );

      const edgesCreated = await detectCoEditedEdges(testBrainId);

      expect(edgesCreated).toBe(0);
    });
  });

  describe("detectBurstEdges", () => {
    it("should detect rapid creation bursts", async () => {
      const now = new Date();

      // Create 4 memories within 1 minute each
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) {
        const result = await db.query(
          `INSERT INTO memories (brain_id, content, created_at)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [testBrainId, `Burst memory ${i}`, new Date(now.getTime() + i * 60 * 1000)]
        );
        ids.push(result.rows[0].id);
      }

      const edgesCreated = await detectBurstEdges(testBrainId, {
        burstWindowMs: 2 * 60 * 1000,
        minBurstSize: 3,
      });

      // 4 memories = 6 edges (full mesh)
      expect(edgesCreated).toBe(6);

      const links = await db.query(
        `SELECT COUNT(*) as count
         FROM memory_derived_links
         WHERE relationship_type = 'TEMPORAL_BURST'
           AND source_id = ANY($1::uuid[])`,
        [ids]
      );

      expect(parseInt(links.rows[0].count, 10)).toBe(6);
    });

    it("should ignore small bursts below minBurstSize", async () => {
      const now = new Date();

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "Memory 1", now]
      );

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "Memory 2", new Date(now.getTime() + 60 * 1000)]
      );

      const edgesCreated = await detectBurstEdges(testBrainId, {
        burstWindowMs: 2 * 60 * 1000,
        minBurstSize: 3,
      });

      expect(edgesCreated).toBe(0);
    });
  });

  describe("detectAllTemporalEdges", () => {
    it("should run all detection algorithms", async () => {
      const now = new Date();

      // Create sequence
      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "Seq 1", now]
      );

      await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)`,
        [testBrainId, "Seq 2", new Date(now.getTime() + 3 * 60 * 1000)]
      );

      const result = await detectAllTemporalEdges(testBrainId);

      expect(result.sequence).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
    });
  });

  describe("updateTemporalEdgesForMemory", () => {
    it("should create edges for a single new memory", async () => {
      const now = new Date();

      // Create existing memory
      const existingMem = await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testBrainId, "Existing memory", now]
      );

      // Create new memory 2 minutes later
      const newMem = await db.query(
        `INSERT INTO memories (brain_id, content, created_at)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [testBrainId, "New memory", new Date(now.getTime() + 2 * 60 * 1000)]
      );

      const edgesCreated = await updateTemporalEdgesForMemory(newMem.rows[0].id);

      expect(edgesCreated).toBeGreaterThanOrEqual(1);

      const links = await db.query(
        `SELECT *
         FROM memory_derived_links
         WHERE (source_id = $1 AND target_id = $2)
            OR (source_id = $2 AND target_id = $1)`,
        [existingMem.rows[0].id, newMem.rows[0].id]
      );

      expect(links.rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});

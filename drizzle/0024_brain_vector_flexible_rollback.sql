-- Rollback: 0024_brain_vector_flexible
-- Date: 2026-08-25
--
-- Re-pins the embedding column back to vector(1536). This ONLY succeeds if every stored
-- embedding is NULL or already 1536-d — a column holding, say, 1024-d voyage vectors
-- cannot be narrowed and the ALTER will error (by design: it refuses to truncate data).
-- Clear the column first if needed:
--     UPDATE "memories" SET "embedding" = NULL WHERE "embedding" IS NOT NULL;
--
-- The HNSW index is NOT recreated here: CONCURRENTLY cannot run inside the implicit
-- transaction apply-migration.ts wraps this file in. To restore it, re-apply
-- drizzle/0023_brain_vector_hnsw.sql separately (after a backfill).
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0024_brain_vector_flexible_rollback.sql

ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector(1536) USING "embedding"::vector(1536);

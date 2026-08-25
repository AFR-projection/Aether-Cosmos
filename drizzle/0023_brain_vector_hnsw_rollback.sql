-- Rollback for 0023_brain_vector_hnsw
-- Date: 2026-08-25
--
-- Drops the HNSW index. CONCURRENTLY so it never blocks readers; single statement so it
-- is not wrapped in a transaction (DROP INDEX CONCURRENTLY may not run in one).
--
-- Apply: npx tsx scripts/apply-migration.ts drizzle/0023_brain_vector_hnsw_rollback.sql

DROP INDEX CONCURRENTLY IF EXISTS "memories_embedding_hnsw_idx";

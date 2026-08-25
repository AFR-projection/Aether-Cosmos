-- Migration: 0024_brain_vector_flexible
-- Date: 2026-08-25
--
-- Second Brain 2.0 — P9 multi-model embeddings: make the embedding column
-- DIMENSION-FLEXIBLE so every OpenRouter model works, not only 1536-d ones.
--
-- Why: a fixed `vector(1536)` column (0022) plus a pinned `dimensions:1536` request
-- rejected every model with a different native width — e.g. voyageai/voyage-code-4,
-- whose accepted widths are 256/512/1024/2048. The app now auto-detects each model's
-- width and stores vectors at that width; the column must therefore be dimensionless.
--
-- Tradeoff: a dimensionless `vector` column CANNOT carry an HNSW/ANN index (that needs a
-- fixed width), so the fixed-width index from 0023 is dropped. Semantic retrieval falls
-- back to an exact `<=>` scan, which is bounded per brain and fine at this scale.
--
-- Apply:    npx tsx scripts/apply-migration.ts drizzle/0024_brain_vector_flexible.sql
-- Rollback: npx tsx scripts/apply-migration.ts drizzle/0024_brain_vector_flexible_rollback.sql
-- Verify:   npx tsx scripts/verify-embedding-schema.ts
--
-- Both statements are transaction-safe (a plain DROP INDEX, then an ALTER TYPE over a
-- column that is empty/NULL), so running them together in apply-migration.ts's single
-- implicit transaction is fine — unlike the CONCURRENTLY index in 0023.

-- Drop the fixed-width ANN index first: the column type cannot change while an index
-- depends on it.
DROP INDEX IF EXISTS "memories_embedding_hnsw_idx";

-- Relax vector(1536) → dimensionless vector. Existing values are all NULL (embeddings
-- are recomputed by the backfill under whatever model is now configured), so the cast
-- rewrites nothing.
ALTER TABLE "memories" ALTER COLUMN "embedding" TYPE vector USING "embedding"::vector;

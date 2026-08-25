-- Migration: 0022_brain_vector
-- Date: 2026-08-25
--
-- Second Brain 2.0 — P9 semantic embeddings (OpenRouter provider).
-- ADDITIVE ONLY: enables pgvector, adds three nullable columns to `memories`, and
-- creates the single-row `brain_embedding_settings` config table. No existing column,
-- constraint or row is altered, so an un-embedded brain keeps working unchanged.
--
-- Apply:    npx tsx scripts/apply-migration.ts drizzle/0022_brain_vector.sql
-- Rollback: npx tsx scripts/apply-migration.ts drizzle/0022_brain_vector_rollback.sql
-- Verify:   npx tsx scripts/verify-embedding-schema.ts
--
-- The HNSW index is deliberately NOT here — it belongs in 0023, built CONCURRENTLY
-- AFTER the column is backfilled, so index construction never blocks writes and never
-- indexes a mostly-NULL column.

-- pgvector. Available on Neon; no-op if already enabled.
CREATE EXTENSION IF NOT EXISTS vector;

-- Dense embedding + its provenance. NULL until a provider is configured and the embed
-- job runs; the semantic retrieval leg abstains for NULL rows rather than failing.
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding" vector(1536);
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding_model" text;
ALTER TABLE "memories" ADD COLUMN IF NOT EXISTS "embedding_updated_at" timestamptz;

-- Global (single-row) provider configuration. The API key is stored ENCRYPTED
-- (AES-256-GCM) and is never returned to any client.
CREATE TABLE IF NOT EXISTS "brain_embedding_settings" (
  "id" text PRIMARY KEY DEFAULT 'default',
  "provider" text NOT NULL DEFAULT 'openrouter',
  "model" text NOT NULL DEFAULT 'openai/text-embedding-3-small',
  "api_key_encrypted" text,
  "dimensions" integer NOT NULL DEFAULT 1536,
  "enabled" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

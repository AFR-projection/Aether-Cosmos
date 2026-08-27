-- Migration 0024: Multi-modal embeddings and temporal edge types
-- Created: 2026-08-28

-- Multi-modal embedding storage
CREATE TABLE IF NOT EXISTS memory_embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  model TEXT NOT NULL, -- 'text-embedding-3-large', 'voyage-3', 'bge-m3', etc.
  embedding vector, -- pgvector for cosine similarity
  dimensions INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(memory_id, model)
);

CREATE INDEX IF NOT EXISTS idx_memory_embeddings_memory_id ON memory_embeddings(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_model ON memory_embeddings(model);

-- Vector similarity index for each model (created dynamically as models are added)
-- Example: CREATE INDEX idx_memory_embeddings_voyage3_vector ON memory_embeddings USING ivfflat (embedding vector_cosine_ops) WHERE model = 'voyage-3';

-- Add temporal edge types to existing relationship_type enum (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TEMPORAL_SEQUENCE'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'relationship_type')
  ) THEN
    ALTER TYPE relationship_type ADD VALUE 'TEMPORAL_SEQUENCE';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TEMPORAL_COEDITED'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'relationship_type')
  ) THEN
    ALTER TYPE relationship_type ADD VALUE 'TEMPORAL_COEDITED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TEMPORAL_BURST'
    AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'relationship_type')
  ) THEN
    ALTER TYPE relationship_type ADD VALUE 'TEMPORAL_BURST';
  END IF;
END $$;

-- Indexes for temporal edge detection queries
CREATE INDEX IF NOT EXISTS idx_memories_created_at_brain ON memories(brain_id, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_memories_updated_at_brain ON memories(brain_id, updated_at) WHERE deleted_at IS NULL AND updated_at > created_at;

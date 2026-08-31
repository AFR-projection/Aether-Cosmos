-- SQL Script untuk Setup Aiven Database
-- Jalankan script ini di Aiven SQL console atau via psql

-- 1. Install pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Verify extension
SELECT * FROM pg_extension WHERE extname = 'vector';

-- Done! Setelah ini jalankan: npm run db:push

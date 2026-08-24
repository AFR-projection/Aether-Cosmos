-- ROLLBACK for 0020_phase2_derived_relationships
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0020_phase2_derived_relationships_rollback.sql
--
-- Safe to run at any time, including on a database where 0020 was never applied
-- (every statement is IF EXISTS). It removes ONLY objects 0020 created:
--
--   - table memory_derived_links (with its constraints and its four indexes)
--   - index memory_tag_map_tag_idx
--   - enums memory_relation_origin, memory_relation_status
--
-- What it does NOT touch, by design:
--   - memory_links and every other pre-existing table: 0020 was additive, so there is
--     no data change to undo.
--   - memories, tags, entities: untouched by 0020.
--
-- Data loss on rollback is total but harmless: derived edges are computed artifacts.
-- Re-applying 0020 and running one relate_brain sweep per brain rebuilds them from the
-- memories themselves. Explicit links, which are the curated knowledge, live in
-- memory_links and are not involved.
--
-- Order matters: the table depends on both enums, so it goes first.

DROP TABLE IF EXISTS "memory_derived_links";

DROP INDEX IF EXISTS "memory_tag_map_tag_idx";

DROP TYPE IF EXISTS "memory_relation_origin";
DROP TYPE IF EXISTS "memory_relation_status";

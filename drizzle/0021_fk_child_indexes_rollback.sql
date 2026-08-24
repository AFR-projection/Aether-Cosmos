-- ROLLBACK for 0021_fk_child_indexes
--
-- Usage: npx tsx scripts/apply-migration.ts drizzle/0021_fk_child_indexes_rollback.sql
--
-- Drops only the thirteen indexes 0021 created. No data is involved: an index carries no
-- information of its own, so this is reversible in both directions at any time. The only
-- consequence of running it is that parent DELETEs go back to scanning their child
-- tables.

DROP INDEX IF EXISTS "memory_derived_links_source_memory_idx";
DROP INDEX IF EXISTS "memory_derived_links_target_memory_idx";
DROP INDEX IF EXISTS "memories_created_by_idx";
DROP INDEX IF EXISTS "memories_created_by_agent_idx";
DROP INDEX IF EXISTS "memory_links_created_by_idx";
DROP INDEX IF EXISTS "memory_links_created_by_agent_idx";
DROP INDEX IF EXISTS "memory_versions_changed_by_idx";
DROP INDEX IF EXISTS "memory_versions_changed_by_agent_idx";
DROP INDEX IF EXISTS "memory_mentions_entity_fk_idx";
DROP INDEX IF EXISTS "archive_job_items_file_idx";
DROP INDEX IF EXISTS "deletion_job_items_file_idx";
DROP INDEX IF EXISTS "shares_shared_by_idx";
DROP INDEX IF EXISTS "sessions_impersonating_idx";

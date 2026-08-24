-- Migration: 0021_fk_child_indexes
-- Date: 2026-08-24
--
-- ADDITIVE ONLY: thirteen indexes. No table, column, constraint or row is touched.
-- Rollback: drizzle/0021_fk_child_indexes_rollback.sql
--   (npx tsx scripts/apply-migration.ts drizzle/0021_fk_child_indexes_rollback.sql)
--
-- WHY
-- Postgres does not index the child side of a foreign key for you. Every DELETE on the
-- parent must then prove no child row references the deleted id, and with no index that
-- proof is a sequential scan of the whole child table — inside the deleting
-- transaction, holding its locks.
--
-- `scripts/audit-db.ts` found 24 such foreign keys. This migration covers the 13 whose
-- child tables grow with ordinary use, so the scan cost grows with them. The remaining
-- 11 sit on tables that are empty and only fill when a feature ships
-- (brain_retrieval_events, brain_review_items, oauth_authorization_codes,
-- file_versions, folder_invitations, folder_members.invited_by, deletion_jobs.folder_id,
-- archive_jobs.folder_id, brain_agents.api_key_id); an index on an empty table is pure
-- write cost, so they are deliberately left for the migration that fills them.
--
-- The two memory_derived_links entries are the load-bearing ones. Its existing indexes
-- all lead with brain_id, which a foreign-key check cannot use, and the table is
-- expected to hold up to RELATE_DEFAULTS.maxEdges (4000) rows per brain. Without these,
-- hard-deleting one memory scans every derived edge in the database.

-- PHASE 2's own table: FK checks on both endpoints (cascade on memory delete).
CREATE INDEX IF NOT EXISTS "memory_derived_links_source_memory_idx" ON "memory_derived_links" USING btree ("source_memory_id");
CREATE INDEX IF NOT EXISTS "memory_derived_links_target_memory_idx" ON "memory_derived_links" USING btree ("target_memory_id");

-- Authorship columns: touched when a user is deleted or an agent's key is revoked.
CREATE INDEX IF NOT EXISTS "memories_created_by_idx" ON "memories" USING btree ("created_by");
CREATE INDEX IF NOT EXISTS "memories_created_by_agent_idx" ON "memories" USING btree ("created_by_agent");
CREATE INDEX IF NOT EXISTS "memory_links_created_by_idx" ON "memory_links" USING btree ("created_by");
CREATE INDEX IF NOT EXISTS "memory_links_created_by_agent_idx" ON "memory_links" USING btree ("created_by_agent");
CREATE INDEX IF NOT EXISTS "memory_versions_changed_by_idx" ON "memory_versions" USING btree ("changed_by");
CREATE INDEX IF NOT EXISTS "memory_versions_changed_by_agent_idx" ON "memory_versions" USING btree ("changed_by_agent");

-- Entity merge/delete walks every mention of the entity.
CREATE INDEX IF NOT EXISTS "memory_mentions_entity_fk_idx" ON "memory_mentions" USING btree ("entity_id");

-- File and folder deletes cascade into job item tables.
CREATE INDEX IF NOT EXISTS "archive_job_items_file_idx" ON "archive_job_items" USING btree ("file_id");
CREATE INDEX IF NOT EXISTS "deletion_job_items_file_idx" ON "deletion_job_items" USING btree ("file_id");

-- User delete cascades into shares and sessions.
CREATE INDEX IF NOT EXISTS "shares_shared_by_idx" ON "shares" USING btree ("shared_by");
CREATE INDEX IF NOT EXISTS "sessions_impersonating_idx" ON "sessions" USING btree ("impersonating_user_id");

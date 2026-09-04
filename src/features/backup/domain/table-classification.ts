/**
 * Which class every table in the schema belongs to.
 *
 * A census, not a dump plan. Nothing here builds a command line: it exists so two
 * questions have one answer each, and so a migration cannot change the answer
 * silently.
 *
 *   1. **Is every table in `schema.ts` accounted for?** `tests/backup-table-classification.test.ts`
 *      reads the real `pgTable` exports and fails when one appears in no class. A table
 *      nobody classified is a table nobody decided the backup story for.
 *   2. **Does the per-account archive cover its domain?** `tests/backup-account-tables.test.ts`
 *      takes {@link FILES_TABLES} and {@link BRAIN_TABLES} as the universe each `.afrbak`
 *      must either carry or explain, so "the backup does not contain X" is discoverable
 *      before the disaster instead of after it.
 *
 * The other property this file makes testable is the reason the two archives can exist
 * separately at all: no foreign key crosses between `files` and `brain`. That test lives
 * next to the first one and would fail the moment a migration drew such an edge.
 *
 * Names are SQL table names, not Drizzle export names, because that is what every
 * consumer — the tests, the INDEX lines of an archive, an operator reading psql —
 * actually speaks.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §1.1, §5.3.
 */

/**
 * The shared spine: rows an account does not own and a restore must never write.
 *
 * Carried by neither archive, for exactly that reason — a `.afrbak` that could write
 * `users` or `activity_logs` would be a file that rewrites the instance it lands in.
 * The class exists so those tables are classified rather than merely absent.
 *
 * `api_keys` is core and that is not a judgement call: `brain_agents.api_key_id`
 * references it, so it can belong to no single domain.
 */
export const CORE_TABLES = [
  "users",
  "system_settings",
  "mail_senders",
  "oauth_clients",
  "api_keys",
  "webhooks",
  "activity_scopes",
  "activity_logs",
] as const;

/**
 * `file_contents.content_json` holds **note bodies**, so notes ride with Files,
 * not with Brain. Worth saying out loud, because "notes" sounds like a Second
 * Brain concern and is not one here. This is also the only domain with R2 blobs
 * behind it.
 */
export const FILES_TABLES = [
  "folders",
  "files",
  "file_contents",
  "file_versions",
  "shares",
  "folder_members",
  "folder_invitations",
  "change_history",
] as const;

/** `memories.embedding` rides along: delivery is a download with no size ceiling. */
export const BRAIN_TABLES = [
  "brains",
  "brain_agents",
  "brain_access",
  "memories",
  "memory_versions",
  "memory_tags",
  "memory_tag_map",
  "brain_projects",
  "brain_entities",
  "brain_relationships",
  "memory_links",
  "memory_mentions",
  "brain_embedding_settings",
  "brain_review_items",
  "brain_audit_logs",
] as const;

/** Derived. Restore re-enqueues the jobs that rebuild the first three. */
export const DERIVED_TABLES = [
  "memory_derived_links",
  "brain_graph_metrics",
  "brain_health_snapshots",
  "brain_retrieval_events",
] as const;

/**
 * Never restored. Live session tokens and half-finished uploads are a security
 * hole and a source of phantom work, not a recovery.
 *
 * `backup_keys` is here for a subtler reason. Per-file phrases left it inert — nothing in the
 * per-account feature reads or writes it any more, since every archive's phrase is derived from
 * `BACKUP_MASTER_KEY` and its download ticket rather than sealed in a row — but whatever the
 * removed whole-instance backup left in it is still wrapped key material. A copy adopted from an
 * archive would be an unreadable blob that *looks* like a usable key, and — worse — a second door
 * into an account nobody typed a phrase for.
 *
 * The three per-account tables (`account_backup_identities`, `restore_batches`,
 * `restore_reservations`) are here for the sharpest reason of all. A restored
 * `account_backup_identities` row would let an archive be *adopted* without anyone
 * typing its recovery phrase, and that phrase is the only gate standing between a
 * stolen `.afrbak` and the account it came from. `restore_batches` and
 * `restore_reservations` describe a restore that was running on another machine:
 * carrying them across would reserve quota for work that will never finish and
 * point a batch id at rows that do not exist here.
 */
export const NEVER_TABLES = [
  "sessions",
  "otp_tokens",
  "oauth_access_tokens",
  "oauth_authorization_codes",
  "upload_sessions",
  "upload_parts",
  "archive_jobs",
  "archive_job_items",
  "deletion_jobs",
  "deletion_job_items",
  "backup_keys",
  "account_backup_identities",
  "restore_batches",
  "restore_reservations",
] as const;

export type TableClass = "core" | "files" | "brain" | "derived" | "never";

export const TABLE_CLASSES: Record<TableClass, readonly string[]> = {
  core: CORE_TABLES,
  files: FILES_TABLES,
  brain: BRAIN_TABLES,
  derived: DERIVED_TABLES,
  never: NEVER_TABLES,
};

/** Every table this module knows about. */
export const ALL_TABLES: readonly string[] = [
  ...CORE_TABLES,
  ...FILES_TABLES,
  ...BRAIN_TABLES,
  ...DERIVED_TABLES,
  ...NEVER_TABLES,
];

export function classifyTable(name: string): TableClass | null {
  for (const [cls, tables] of Object.entries(TABLE_CLASSES) as [
    TableClass,
    readonly string[],
  ][]) {
    if (tables.includes(name)) return cls;
  }
  return null;
}

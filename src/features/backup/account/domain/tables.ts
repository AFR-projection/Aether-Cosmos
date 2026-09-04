import type { BackupDomain } from "@backup/domain/types";
import { fail, safeLabel } from "./fields";

/**
 * TABLES — which rows belong to one account, and what a restore may do with each column.
 *
 * The other modules in this folder describe *bytes*. This one describes *rows*: it is the
 * single place that answers "does this table travel in a per-account archive, and if so
 * what happens to each of its columns on the way back in". The exporter reads it to build
 * its SELECTs, the importer reads it to build its INSERTs, and the brain INDEX's `table`
 * field is checked for membership here — `index-entries.ts` deliberately does not know the
 * table list, so that a byte layout never goes stale when the schema moves.
 *
 * Four things are load-bearing, and they are stated here rather than left to the caller:
 *
 *  1. **No column is carried by default.** Every column of every per-account table has an
 *     explicit rule, and `tests/backup-account-tables.test.ts` walks the Drizzle schema to
 *     prove the two agree. Adding a column to `memories` therefore fails a test until
 *     somebody decides whether a backup carries it — which is the only way a descriptor
 *     like this is still true a year from now.
 *  2. **Ids are never carried.** A row's primary key is reissued and recorded in a mapping
 *     so the archive's internal references survive (§11); a column pointing at another row
 *     is a `ref` resolved through that mapping, never trusted as a value. That is what
 *     makes it impossible for an archive to name a row it does not itself contain —
 *     including a row belonging to somebody else.
 *  3. **Scope comes from the caller, never from the archive.** `owner` columns are
 *     overwritten with the authenticated caller's id, so an archive cannot land in another
 *     account merely because this server holds `BACKUP_MASTER_KEY` (§10).
 *  4. **What is left out is written down.** {@link EXCLUDED_ACCOUNT_TABLES} carries a
 *     reason per omitted table, because "the backup does not contain X" is exactly the
 *     kind of fact that has to be discoverable before the disaster, not after it.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §1.1, §5.3,
 * §7.3, §7.5, §11, §17.
 */

/* ── vocabulary ───────────────────────────────────────────────────────────── */

/**
 * Where a carried table's rows live inside the archive.
 *
 * `index` — the row *is* an INDEX line (`folder` / `file`), so its shape is fixed by
 *           `index-entries.ts` and only the fields that line has can travel.
 * `payload` — the row travels as a file's CHUNKS bytes rather than as a line of its own.
 *           `file_contents` is the only one: a note has no R2 object, so its Tiptap body
 *           is what the payload for that file entry holds.
 * `ndjson` — one INDEX line naming the row plus one canonical-JSON object in CHUNKS. The
 *           whole brain domain works this way.
 */
export type RowOrigin = "index" | "payload" | "ndjson";

/** Why a column never travels. Each value is a different promise to the user. */
export type DropReason =
  /** `GENERATED ALWAYS AS … STORED`. Postgres refuses an INSERT that names it at all. */
  | "generated"
  /** Recomputed after the restore by a path that already exists (§17): embeddings, FTS. */
  | "derived"
  /** Points at a core table. A per-account restore never touches `CORE_TABLES`. */
  | "core"
  /** Bookkeeping of one upload on one server; meaningless in another database. */
  | "transient"
  /** The archive format has no field for it. A stated loss — see the note on the rule. */
  | "unrepresented";

/**
 * What happens to one column, on the way out and on the way back in.
 *
 * `note` is not decoration: for the rules that lose or rewrite information it is the
 * record of *why*, and it is what the report to the user is assembled from.
 */
export type ColumnRule = { readonly note?: string } & (
  | { readonly rule: "carry" }
  | {
      readonly rule: "time";
      /**
       * Provenance timestamps (`created_at`, `enriched_at`, `last_recalled_at`) are
       * clamped to import time, because a row that claims to have been written next year
       * sorts above everything real in every list, forever. A validity window is the
       * exception — "true from March" is a legitimate statement about the future.
       */
      readonly future?: "allowed";
    }
  /** The row's own primary key: a fresh uuid, recorded in this table's id mapping. */
  | { readonly rule: "id" }
  /** An id pointing at another row of the same archive, resolved through its mapping. */
  | { readonly rule: "ref"; readonly table: string; readonly nullable?: true }
  /**
   * Overwritten with the restoring account's user id.
   *
   * Unconditionally, including where the source row held NULL: an `owner` column never
   * travels (see {@link carriedColumns}), so there is no NULL in the archive to preserve and
   * nothing to distinguish "written by nobody" from "written by somebody this database has
   * never heard of". `nullable` records that the column *accepts* NULL, which is what makes
   * the rule usable on `memories.created_by`; it is not a promise to write one.
   */
  | { readonly rule: "owner"; readonly nullable?: true }
  /** The archive's opinion is never read; the server decides. `note` says what it decides. */
  | { readonly rule: "server" }
  /** Carried inside the INDEX entry's `path`, not as a field of its own. */
  | { readonly rule: "path" }
  /** Carried as the file entry's CHUNKS bytes — see {@link NOTE_BODY_KEYS}. */
  | { readonly rule: "payload" }
  | { readonly rule: "drop"; readonly why: DropReason }
);

/** How a table's rows are tied to the account that owns them. */
export type AccountScope =
  /** The table has the owning user's id on it: `folders.user_id`, `brains.owner_user_id`. */
  | { readonly via: "column"; readonly column: string }
  /** Reached through a parent that is itself in scope: `memories.brain_id` → `brains`. */
  | { readonly via: "parent"; readonly table: string; readonly column: string };

export interface AccountTable {
  /** SQL name, spelled as `table-classification.ts` spells it. */
  readonly name: string;
  readonly domain: BackupDomain;
  readonly origin: RowOrigin;
  /**
   * Insert rank. Every `ref` must point at a table of strictly lower rank, which
   * `assertInsertOrder()` proves — that property is the whole reason the brain importer
   * can insert a memory before the link that references it without knowing the schema's
   * dependency graph at read time. The exporter walks tables in this order and stamps a
   * running counter into each INDEX line's `orderKey`, so `orderKey` ascending and this
   * rank agreeing is what the importer relies on.
   */
  readonly rank: number;
  readonly scope: AccountScope;
  /** Every column of the real table, no exceptions. The test enforces "every". */
  readonly columns: Readonly<Record<string, ColumnRule>>;
  /**
   * The rows the exporter leaves behind, as prose, so the whole selection is readable in
   * one place. Live content only: an archive is what the account *has*, and a Recycle Bin
   * that travels would restore as content the user already threw away.
   */
  readonly rowFilter?: string;
  /**
   * `CHECK` constraints the importer must evaluate itself, before the INSERT.
   *
   * A hostile archive can spell a row that violates one — a link whose target is its own
   * source, a mention whose offsets run backwards. Left to Postgres, that is a constraint
   * violation mid-transaction, which surfaces as a 500 and an aborted transaction instead
   * of refusal #7 with a line number. Checking first is what keeps every refusal a
   * refusal.
   */
  readonly checks?: readonly string[];
}

/**
 * A note's body, as the bytes of its file entry.
 *
 * A note has no R2 object — its body is Tiptap JSON in `file_contents` — so the payload
 * for a note's entry is `rowJsonBytes({annotations, content})`, both keys always present
 * and `null` when empty. Deterministic because the entry's `sha256` covers it: two exports
 * of an unchanged note have to produce the same digest, or `merge` would stop recognising a
 * note it already restored and §7.5's idempotence would quietly break.
 *
 * `rowJsonBytes` and not `canonicalBytes`: a Tiptap document is full of `null`s, which the
 * canonical writer drops rather than emits (see `row-json.ts`). Dropping them would change
 * the document, and the digest would no longer describe what the note actually holds.
 */
export const NOTE_BODY_KEYS = ["annotations", "content"] as const;

/* ── files ────────────────────────────────────────────────────────────────── */

/**
 * The files archive carries folders, files, and the bytes of each — and nothing else.
 *
 * `folders` and `files` do not appear as NDJSON rows at all: they *are* the INDEX's
 * `folder` and `file` lines, whose shape is fixed in `index-entries.ts`. That is why so
 * many columns below are `server` or `drop`: a line has room for a path, two timestamps, a
 * size, a digest and a MIME string, and anything not in that list has to be recomputed on
 * arrival or admitted as lost.
 */
const FILES_TABLES: readonly AccountTable[] = [
  {
    name: "folders",
    domain: "files",
    origin: "index",
    rank: 1,
    scope: { via: "column", column: "user_id" },
    rowFilter: "deleted_at IS NULL — live folders only, so a staged batch can never be re-exported",
    columns: {
      id: { rule: "server", note: "a fresh uuid; the archive names a folder by path, never by id" },
      user_id: { rule: "owner" },
      parent_id: {
        rule: "server",
        note: "found-or-created by walking the entry path's leading segments",
      },
      name: { rule: "path", note: "the entry path's last segment" },
      materialized_path: { rule: "server", note: "recomputed server-side (§11), never read" },
      depth: { rule: "server", note: "recomputed server-side (§11), never read" },
      deleted_at: { rule: "server", note: "NOW() while the batch stages, NULL on commit (§7.3)" },
      restore_batch_id: { rule: "server", note: "the batch id from stage 2" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "files",
    domain: "files",
    origin: "index",
    rank: 2,
    scope: { via: "column", column: "user_id" },
    rowFilter:
      "deleted_at IS NULL AND status IN ('ready','legacy_unverified') — exactly what every " +
      "read path in the app treats as a file the user has (list, download, copy). A " +
      "half-finished upload has no bytes to carry; a legacy row does, and dropping it " +
      "would lose a file the user can see",
    columns: {
      id: { rule: "server", note: "a fresh uuid; the archive names a file by path, never by id" },
      user_id: { rule: "owner" },
      folder_id: { rule: "server", note: "the folder the entry path's parent segments resolve to" },
      name: { rule: "path", note: "the entry path's last segment" },
      mime_type: {
        rule: "carry",
        note: "advisory: re-validated on arrival, and anything that fails becomes application/octet-stream (§11)",
      },
      size_bytes: {
        rule: "carry",
        note: "the entry's `size`, checked against the payload's real length and the reservation",
      },
      r2_key: { rule: "server", note: "§11 — the archive's key is ignored, a new object is always written" },
      status: { rule: "server", note: "'ready': a restored row is complete by construction" },
      checksum_sha256: {
        rule: "carry",
        note: "the entry's `sha256`, hex-encoded as this column has always held it; for a note the exporter computes it over the body it packs",
      },
      completed_at: { rule: "server", note: "stamped at import — it records this server finishing this object" },
      verified_at: { rule: "server", note: "stamped at import, for the same reason" },
      failure_code: { rule: "drop", why: "transient" },
      failure_message: { rule: "drop", why: "transient" },
      is_favorite: {
        rule: "drop",
        why: "unrepresented",
        note: "the `file` line has no flag for it; a lost star is cosmetic, which is why this one is admitted rather than refused",
      },
      is_note: {
        rule: "server",
        note: "inferred on arrival: a `.note` name with an application/json MIME whose payload parses as a Tiptap document. Bytes that do not parse land as an ordinary file instead of failing the restore",
      },
      thumbnail_key: { rule: "drop", why: "derived" },
      content_text: { rule: "server", note: "the FTS input, recomputed from the restored body" },
      search_vector: { rule: "drop", why: "generated" },
      deleted_at: { rule: "server", note: "NOW() while the batch stages, NULL on commit (§7.3)" },
      version: { rule: "server", note: "1 — one body per entry, and no version history travels" },
      encrypted: {
        rule: "drop",
        why: "unrepresented",
        note: "this one is NOT admitted: an account holding client-side-encrypted files is refused before the first byte, because ciphertext restored without its `encryption_meta` is a file nobody can ever open again. Same refusal the folder ZIP download already makes",
      },
      encryption_meta: { rule: "drop", why: "unrepresented", note: "see `encrypted`" },
      restore_batch_id: { rule: "server", note: "the batch id from stage 2" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "file_contents",
    domain: "files",
    origin: "payload",
    rank: 3,
    scope: { via: "parent", table: "files", column: "file_id" },
    rowFilter: "the parent file is a note — every other file's bytes live in R2",
    columns: {
      id: { rule: "server", note: "a fresh uuid; this row is reached through its file, never named" },
      file_id: { rule: "server", note: "the `files` row this same import just created" },
      content_json: { rule: "payload" },
      annotations_json: { rule: "payload" },
      updated_at: { rule: "time", note: "the file entry's `updatedAt`, so a note keeps its edit time" },
    },
  },
];

/* ── brain ────────────────────────────────────────────────────────────────── */

/**
 * The brain archive carries the account's brains and everything hanging off them.
 *
 * One property makes the importer far simpler than it looks, and it is worth writing down
 * because a future index could take it away: **every unique constraint in this domain is
 * scoped by a column the restore reissues** — `brain_id`, `memory_id`, `source_memory_id`.
 * A restored brain gets a fresh `brains.id`, so nothing underneath it can collide with
 * anything already in the database, and `merge` needs no conflict handling at all.
 *
 * The single exception is `brains_owner_default_unique`, a partial unique on
 * `(owner_user_id) WHERE is_default`, which is scoped by the *owner* — the one column the
 * restore does not reissue. Hence `is_default` being `server` below.
 */
const BRAIN_TABLES: readonly AccountTable[] = [
  {
    name: "brains",
    domain: "brain",
    origin: "ndjson",
    rank: 1,
    scope: { via: "column", column: "owner_user_id" },
    rowFilter: "every brain the account owns, archived ones included",
    columns: {
      id: { rule: "id" },
      owner_user_id: { rule: "owner" },
      name: { rule: "carry" },
      description: { rule: "carry" },
      is_default: {
        rule: "server",
        note: "false when the account already has a default brain — `brains_owner_default_unique` is the one unique a restore can collide with, and losing the flag is a preference, not data",
      },
      status: { rule: "carry" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "brain_agents",
    domain: "brain",
    origin: "ndjson",
    rank: 2,
    scope: { via: "column", column: "owner_user_id" },
    columns: {
      id: { rule: "id" },
      owner_user_id: { rule: "owner" },
      name: { rule: "carry" },
      description: { rule: "carry" },
      type: { rule: "carry" },
      status: { rule: "carry" },
      api_key_id: {
        rule: "drop",
        why: "core",
        note: "`api_keys` is a core table this restore must not write; the agent comes back keyless and is re-linked by hand",
      },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "brain_projects",
    domain: "brain",
    origin: "ndjson",
    rank: 3,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      name: { rule: "carry" },
      description: { rule: "carry" },
      status: { rule: "carry" },
      metadata: { rule: "carry" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "brain_entities",
    domain: "brain",
    origin: "ndjson",
    rank: 4,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      name: { rule: "carry" },
      type: { rule: "carry" },
      description: { rule: "carry" },
      metadata: { rule: "carry" },
      aliases: { rule: "carry" },
      mention_count: {
        rule: "carry",
        note: "recomputable from `memory_mentions`, but the mentions travel too, so carrying it keeps the two agreeing without a pass over the graph",
      },
      first_seen_at: { rule: "time" },
      last_seen_at: { rule: "time" },
      extracted_by: { rule: "carry" },
      extraction_confidence: { rule: "carry" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "memories",
    domain: "brain",
    origin: "ndjson",
    rank: 5,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    rowFilter: "deleted_at IS NULL — live memories only, matching what the files domain does",
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      type: { rule: "carry" },
      title: { rule: "carry" },
      content: { rule: "carry" },
      summary: { rule: "carry" },
      importance: { rule: "carry" },
      confidence: { rule: "carry" },
      source_type: { rule: "carry" },
      source_id: {
        rule: "carry",
        note: "free text, not a row of this database: it labels where the memory came from (a conversation, a tool run) and there is nothing here to remap it against. The only `_id` column in the whole descriptor that is carried verbatim, which `tests/backup-account-tables.test.ts` names so it stays the only one",
      },
      created_by: {
        rule: "owner",
        nullable: true,
        note: "authorship of a row written by another principal collapses onto the restoring account: a foreign user id means nothing in a rebuilt database, and the archive deliberately carries no foreign identity (§11)",
      },
      created_by_agent: { rule: "ref", table: "brain_agents", nullable: true },
      project_id: { rule: "ref", table: "brain_projects", nullable: true },
      metadata: { rule: "carry" },
      version: { rule: "carry" },
      archived_at: { rule: "time" },
      last_accessed_at: { rule: "time" },
      deleted_at: { rule: "server", note: "NULL — the export selects live rows only" },
      content_hash: { rule: "carry" },
      enriched_hash: {
        rule: "carry",
        note: "carried together with `content_hash` so enrichment sees a row it has already processed and does no work twice — the mentions and links it would produce travel too",
      },
      enrichment_status: { rule: "carry" },
      enrichment_error: { rule: "carry" },
      enriched_at: { rule: "time" },
      recall_count: { rule: "carry" },
      last_recalled_at: { rule: "time" },
      confirmation_count: { rule: "carry" },
      last_confirmed_at: { rule: "time" },
      valid_from: { rule: "time", future: "allowed" },
      valid_until: { rule: "time", future: "allowed" },
      validity_state: { rule: "carry" },
      superseded_by_id: {
        rule: "ref",
        table: "memories",
        nullable: true,
        note: "the one self-reference in either domain. The importer inserts every memory with this NULL and fills it in a second pass, which is also why a chain of supersessions needs no ordering inside the table",
      },
      aliases: { rule: "carry" },
      embedding: {
        rule: "drop",
        why: "derived",
        note: "§17 — recomputed by the embed job, which claims any row whose vector is absent. Carrying it would also multiply the payload by a 1536-float array per memory",
      },
      embedding_model: { rule: "drop", why: "derived", note: "absent means 'not embedded yet'" },
      embedding_updated_at: { rule: "drop", why: "derived" },
      search_vector: { rule: "drop", why: "generated" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "memory_versions",
    domain: "brain",
    origin: "ndjson",
    rank: 6,
    scope: { via: "parent", table: "memories", column: "memory_id" },
    columns: {
      id: { rule: "id" },
      memory_id: { rule: "ref", table: "memories" },
      version_number: { rule: "carry" },
      title: { rule: "carry" },
      content: { rule: "carry" },
      summary: { rule: "carry" },
      changed_by: { rule: "owner", nullable: true, note: "as `memories.created_by`" },
      changed_by_agent: { rule: "ref", table: "brain_agents", nullable: true },
      change_reason: { rule: "carry" },
      metadata: { rule: "carry" },
      created_at: { rule: "time" },
    },
  },
  {
    name: "memory_tags",
    domain: "brain",
    origin: "ndjson",
    rank: 7,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      name: { rule: "carry" },
      created_at: { rule: "time" },
    },
  },
  {
    name: "memory_tag_map",
    domain: "brain",
    origin: "ndjson",
    rank: 8,
    scope: { via: "parent", table: "memories", column: "memory_id" },
    /**
     * The one table with no `id`: its primary key is the pair itself. So it has no mapping
     * entry, nothing can reference it, and a duplicate pair in a hostile archive is caught
     * by the primary key rather than by us — which is fine, because the pair is remapped
     * and can only ever name rows this same restore created.
     */
    columns: {
      memory_id: { rule: "ref", table: "memories" },
      tag_id: { rule: "ref", table: "memory_tags" },
    },
  },
  {
    name: "brain_relationships",
    domain: "brain",
    origin: "ndjson",
    rank: 9,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      source_entity_id: { rule: "ref", table: "brain_entities" },
      target_entity_id: { rule: "ref", table: "brain_entities" },
      relationship_type: { rule: "carry" },
      confidence: { rule: "carry" },
      metadata: { rule: "carry" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "memory_links",
    domain: "brain",
    origin: "ndjson",
    rank: 10,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    checks: [
      "memory_links_one_target",
      "memory_links_target_type_matches",
      "memory_links_no_self_link",
    ],
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      source_memory_id: { rule: "ref", table: "memories" },
      target_type: { rule: "carry" },
      target_memory_id: { rule: "ref", table: "memories", nullable: true },
      target_entity_id: { rule: "ref", table: "brain_entities", nullable: true },
      link_type: { rule: "carry" },
      metadata: { rule: "carry" },
      created_by: { rule: "owner", nullable: true, note: "as `memories.created_by`" },
      created_by_agent: { rule: "ref", table: "brain_agents", nullable: true },
      created_at: { rule: "time" },
    },
  },
  {
    name: "memory_mentions",
    domain: "brain",
    origin: "ndjson",
    rank: 11,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    checks: ["memory_mentions_offsets", "memory_mentions_field"],
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      memory_id: { rule: "ref", table: "memories" },
      entity_id: { rule: "ref", table: "brain_entities" },
      field: { rule: "carry" },
      surface: { rule: "carry" },
      start_offset: { rule: "carry" },
      end_offset: { rule: "carry" },
      confidence: { rule: "carry" },
      extracted_by: { rule: "carry" },
      created_at: { rule: "time" },
    },
  },
  {
    name: "brain_review_items",
    domain: "brain",
    origin: "ndjson",
    rank: 12,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    /**
     * The health service regenerates this queue by rescanning, so it looks derived — but
     * `status` and `resolvedAt` are human decisions, and a rescan cannot recover them. A
     * contradiction the user has already dismissed would come back open. So it travels.
     */
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      kind: { rule: "carry" },
      status: { rule: "carry" },
      memory_id: { rule: "ref", table: "memories", nullable: true },
      related_memory_id: { rule: "ref", table: "memories", nullable: true },
      dedupe_key: {
        rule: "server",
        note: "rebuilt with `reviewDedupeKey()` from the remapped ids — the archive's value names ids that no longer exist, and a stale key would let the next scan file the same finding twice",
      },
      reason: { rule: "carry" },
      evidence: { rule: "carry" },
      priority: { rule: "carry" },
      resolved_at: { rule: "time" },
      resolved_by: { rule: "owner", nullable: true },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
  {
    name: "brain_access",
    domain: "brain",
    origin: "ndjson",
    rank: 13,
    scope: { via: "parent", table: "brains", column: "brain_id" },
    rowFilter:
      "principal_type = 'agent' AND principal_id is one of the account's own agents — a grant to another account is that account's data (§1.1), and a grant to the owner is what `brains.owner_user_id` already says",
    columns: {
      id: { rule: "id" },
      brain_id: { rule: "ref", table: "brains" },
      principal_type: { rule: "carry" },
      principal_id: {
        rule: "ref",
        table: "brain_agents",
        note: "a `ref`, not a value, and that is the whole safety argument: it can only ever resolve to an agent this same restore created for this same caller, so an archive cannot grant access to a principal it does not contain",
      },
      role: { rule: "carry" },
      scopes: { rule: "carry" },
      created_at: { rule: "time" },
      updated_at: { rule: "time" },
    },
  },
];

/* ── what a per-account archive leaves behind ─────────────────────────────── */

export interface ExcludedAccountTable {
  readonly name: string;
  readonly domain: BackupDomain;
  /** Written for the user rather than the reviewer: this sentence reaches the report. */
  readonly why: string;
}

/**
 * The tables of the two domains a per-account archive does **not** carry.
 *
 * With the two arrays above, this list is exhaustive: the files side plus the three carried
 * tables is exactly `table-classification.ts`'s eight, and the brain side plus its thirteen
 * is exactly its fifteen — `tests/backup-account-tables.test.ts` checks both sums. An
 * omission therefore cannot happen by forgetting one; it can only happen by writing down a
 * reason for it, which is the point.
 */
export const EXCLUDED_ACCOUNT_TABLES: readonly ExcludedAccountTable[] = [
  {
    name: "file_versions",
    domain: "files",
    why: "One entry carries one body. Version history needs several payloads per file and a second INDEX kind to order them, so an archive restores the current content of every file and says so plainly rather than half-carrying the history.",
  },
  {
    name: "shares",
    domain: "files",
    why: "A share link is a promise this server made to strangers, with its own token and expiry. Recreating it elsewhere would resurrect URLs the account may have deliberately retired, and the new token would not be the one anybody holds anyway.",
  },
  {
    name: "folder_members",
    domain: "files",
    why: "Membership names other accounts (§1.1). Their user ids mean nothing in a rebuilt database, and re-granting access on their behalf would decide something that was never the restoring account's to decide.",
  },
  {
    name: "folder_invitations",
    domain: "files",
    why: "An invitation is addressed to somebody else's email and is only valid until it is accepted or expires. Carrying one across would offer a stranger a folder from a server that no longer exists.",
  },
  {
    name: "change_history",
    domain: "files",
    why: "A log. Its rows describe events on the source server — the actor, the address they came from, and the ids of rows this restore reissues — so every one of them would arrive pointing at nothing.",
  },
  {
    name: "brain_embedding_settings",
    domain: "brain",
    why: "A single instance-wide row holding a provider API key sealed with this server's own secret. It is not the account's data, and the sealed value would be unreadable in another installation even if it were.",
  },
  {
    name: "brain_audit_logs",
    domain: "brain",
    why: "A log, and one whose subjects are all reissued: every memory, entity, and agent id it references is replaced during a restore, which would leave entries describing rows nobody can look up.",
  },
];

/* ── the registry, and the rules the rest of the feature reads it through ─── */

const BY_DOMAIN: Readonly<Record<BackupDomain, readonly AccountTable[]>> = {
  files: FILES_TABLES,
  brain: BRAIN_TABLES,
};

/** One domain's tables, in insert order. */
export function accountTables(domain: BackupDomain): readonly AccountTable[] {
  return BY_DOMAIN[domain];
}

/** One domain's omissions, for the report and for the UI's "what is not in here". */
export function excludedAccountTables(domain: BackupDomain): readonly ExcludedAccountTable[] {
  return EXCLUDED_ACCOUNT_TABLES.filter((entry) => entry.domain === domain);
}

/** A lookup that answers "is this carried at all", with no opinion about refusal. */
export function findAccountTable(
  domain: BackupDomain,
  name: string
): AccountTable | undefined {
  return BY_DOMAIN[domain].find((table) => table.name === name);
}

/**
 * The same lookup as a refusal, for a name that came out of an archive.
 *
 * This is the membership check `index-entries.ts` defers to. It validates the *shape* of a
 * brain INDEX line's `table` — a lowercase identifier and nothing else — and stops there,
 * because a byte layout that knows the current table list stops being readable the next
 * time the list changes. Whether `memory_links` is a thing an account backup carries is
 * policy, it moves with the schema, and it is answered here.
 *
 * The name is flattened through `safeLabel` before it reaches `detail`: it is a string a
 * stranger wrote, and `detail` is read by an operator in a log line.
 */
export function accountTable(
  domain: BackupDomain,
  name: string,
  where: string
): AccountTable {
  const table = findAccountTable(domain, name);
  if (!table) {
    fail(`${where}.table ${safeLabel(name)} is not carried by a ${domain} backup`);
  }
  return table;
}

/**
 * The columns whose value actually travels.
 *
 * Not `drop`, which never leaves the source database, and not `server` or `owner`, which
 * the destination decides without consulting the archive — an exporter that selected those
 * would be writing bytes no importer is allowed to read, which is the quiet way a format
 * grows a field that looks authoritative and is not.
 */
export function carriedColumns(table: AccountTable): string[] {
  return Object.entries(table.columns)
    .filter(([, rule]) => rule.rule !== "drop" && rule.rule !== "server" && rule.rule !== "owner")
    .map(([column]) => column);
}

/** The columns that never travel, with the reason, for the report. */
export function droppedColumns(
  table: AccountTable
): { column: string; why: DropReason; note?: string }[] {
  return Object.entries(table.columns).flatMap(([column, rule]) =>
    rule.rule === "drop" ? [{ column, why: rule.why, note: rule.note }] : []
  );
}

export interface AccountRef {
  readonly column: string;
  /** The table whose id mapping resolves it. */
  readonly table: string;
  readonly nullable: boolean;
}

/**
 * Every `ref` a table has — the importer's whole referential story.
 *
 * **Referential closure, both directions.** On the way out, a row whose non-nullable `ref`
 * target was not exported is skipped, and a nullable `ref` to a target that was not exported
 * becomes NULL; that keeps the archive internally consistent by construction rather than by
 * hope. On the way back in, a `ref` is resolved through the mapping the restore built for
 * the target table, and the two failures are deliberately different: a dangling non-nullable
 * `ref` is refusal #7 — the archive claims a row that it does not contain, so it is not a
 * whole archive — while a dangling nullable `ref` becomes NULL, because "this memory was
 * filed under a project" is information a restore may lose without losing the memory.
 *
 * Nothing here ever trusts the id in the file. That is what makes it impossible for an
 * archive to attach itself to a row belonging to somebody else: the only ids that exist
 * after a restore are ids this restore issued.
 */
export function refsOf(table: AccountTable): AccountRef[] {
  return Object.entries(table.columns).flatMap(([column, rule]) =>
    rule.rule === "ref"
      ? [{ column, table: rule.table, nullable: rule.nullable === true }]
      : []
  );
}

/** Where a table sits in the insert order, for a name that came out of an archive. */
export function insertRankOf(domain: BackupDomain, name: string, where: string): number {
  return accountTable(domain, name, where).rank;
}

/**
 * The property the importer is built on, proved rather than assumed.
 *
 * Insert a table's rows and every id it needs already exists — that is what lets the brain
 * importer stream rows in one pass without knowing the schema's dependency graph at read
 * time. It holds only while every `ref` points at a strictly lower rank, so this walks the
 * descriptor and says so out loud. `tests/backup-account-tables.test.ts` calls it, which is
 * why adding a table that references a later one fails at test time rather than as a foreign
 * key violation halfway through somebody's restore.
 *
 * The one allowed exception is a **nullable self-reference**: `memories.superseded_by_id`
 * points at another memory, and no ordering of one table's rows can satisfy that in a single
 * pass. The importer inserts every memory with it NULL and fills the column in a second pass
 * over the mapping — which is only safe *because* the column is nullable, hence the check.
 *
 * Throws a plain `Error`: this is an invariant of this file, not something an archive can
 * cause, so it must never be reportable as a corrupt-archive refusal.
 *
 * `registry` exists so the guard is itself testable — a check nothing ever fails is not a
 * check. The test hands it a deliberately broken list and expects the throw; production has
 * no reason to pass anything.
 */
export function assertInsertOrder(
  registry: Readonly<Record<BackupDomain, readonly AccountTable[]>> = BY_DOMAIN
): void {
  for (const domain of ["files", "brain"] as const) {
    const tables = registry[domain];
    const ranks = tables.map((table) => table.rank);
    const expected = tables.map((_, index) => index + 1);
    if (ranks.join(",") !== expected.join(",")) {
      throw new Error(`${domain} tables must be ranked 1..${tables.length} in array order`);
    }

    for (const table of tables) {
      if (table.domain !== domain) {
        throw new Error(`${table.name} is listed under ${domain} but claims ${table.domain}`);
      }
      const carried = (name: string) => tables.find((entry) => entry.name === name);
      if (table.scope.via === "parent") {
        const parent = carried(table.scope.table);
        if (!parent || parent.rank >= table.rank) {
          throw new Error(`${table.name} is scoped by ${table.scope.table}, which must be carried and rank lower`);
        }
      }
      for (const ref of refsOf(table)) {
        const target = carried(ref.table);
        if (!target) {
          throw new Error(`${table.name}.${ref.column} references ${ref.table}, which no ${domain} backup carries`);
        }
        if (target.rank === table.rank && ref.nullable) {
          continue; // The documented self-reference, filled in a second pass.
        }
        if (target.rank >= table.rank) {
          throw new Error(`${table.name}.${ref.column} references ${ref.table} at rank ${target.rank}, which is not lower`);
        }
      }
    }
  }
}

/**
 * The five CHECK constraints of the brain domain, spelled once for both directions.
 *
 * Postgres will enforce these whatever we do. The reason they are also written here is that
 * "the database refused the INSERT" is a 500 with a constraint name in it, arriving after a
 * few hundred thousand rows have already been staged — and both halves of the backup need
 * the answer *before* that:
 *
 *   - **The exporter** drops a row that fails one. This is not hypothetical: a link whose
 *     target memory was soft-deleted has its nullable `target_memory_id` nulled by referential
 *     closure (`export-brain.ts`), and a nulled target beside `target_type = 'memory'` is a
 *     row Postgres would reject. Carrying it would produce an archive that cannot be restored
 *     — the worst possible outcome for a backup — so the row does not travel. It is a link
 *     pointing at nothing; there is no information in it to lose.
 *   - **The importer** refuses one as damage (§7 refusal #7). Because the exporter drops them,
 *     a legitimate archive never contains one, so this is purely a hostile-input guard: it
 *     turns a crafted row into a numbered refusal instead of a constraint violation.
 *
 * The predicates read presence and equality only — never a column type — because they run
 * over two different shapes. On the way out the values are archive labels (`"a3f…"`) and on
 * the way back they are the uuids this restore minted. Remapping is one-to-one, so an
 * equality that holds in one spelling holds in the other.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §11.
 */

import type { AccountTable } from "@backup/account/domain/tables";

/** One row, in whichever spelling the caller has: labels on export, uuids on import. */
export type RowCheckValues = Readonly<Record<string, unknown>>;

/**
 * Is this column carrying a value at all?
 *
 * `undefined` and `null` are one answer here and two everywhere else in the format — absent
 * means "not carried, let the default apply", `null` means "SQL NULL". A CHECK constraint
 * cannot tell them apart: both arrive at Postgres as NULL, which is what these mirror.
 */
export function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * The predicates, keyed by the constraint name the descriptor declares.
 *
 * Each one is the SQL, transliterated. The SQL is quoted above it so a schema change that
 * edits one and not the other is visible in a diff of six lines rather than a hunt.
 */
export const ACCOUNT_ROW_CHECKS: Readonly<
  Record<string, ((values: RowCheckValues) => boolean) | undefined>
> = {
  // (("target_memory_id" IS NOT NULL)::int + ("target_entity_id" IS NOT NULL)::int) = 1
  memory_links_one_target: (row) =>
    (isSet(row.target_memory_id) ? 1 : 0) + (isSet(row.target_entity_id) ? 1 : 0) === 1,

  // ("target_type" = 'memory' AND "target_memory_id" IS NOT NULL)
  //   OR ("target_type" = 'entity' AND "target_entity_id" IS NOT NULL)
  memory_links_target_type_matches: (row) =>
    (row.target_type === "memory" && isSet(row.target_memory_id)) ||
    (row.target_type === "entity" && isSet(row.target_entity_id)),

  // "target_memory_id" IS NULL OR "target_memory_id" <> "source_memory_id"
  memory_links_no_self_link: (row) =>
    !isSet(row.target_memory_id) || row.target_memory_id !== row.source_memory_id,

  // "end_offset" > "start_offset"
  //
  // The one place a type is read, and deliberately: these two are `carry` columns, so a
  // hostile archive may put a string in them. Postgres would answer that with a 22P02 on the
  // INSERT; answering it here keeps it a refusal about a numbered row.
  memory_mentions_offsets: (row) =>
    typeof row.start_offset === "number" &&
    typeof row.end_offset === "number" &&
    row.end_offset > row.start_offset,

  // "field" IN ('title', 'summary', 'content')
  memory_mentions_field: (row) =>
    row.field === "title" || row.field === "summary" || row.field === "content",
};

/**
 * The name of the first constraint this row breaks, or `null` if it breaks none.
 *
 * A name the descriptor declares and this module does not implement is a plain `Error`, not a
 * refusal: it means a CHECK was added to the schema and only half-taught to the backup, which
 * is our bug and would otherwise be discovered as an unrestorable archive.
 * `tests/backup-account-import-brain.test.ts` holds the two lists equal so it is discovered
 * in CI instead.
 */
export function rowCheckFailure(table: AccountTable, values: RowCheckValues): string | null {
  for (const name of table.checks ?? []) {
    const check = ACCOUNT_ROW_CHECKS[name];
    if (check === undefined) {
      throw new Error(`${table.name} declares a check ${name} with no implementation`);
    }
    if (!check(values)) return name;
  }
  return null;
}

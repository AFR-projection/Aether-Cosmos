/**
 * `BrainExportSource` over this application's own tables, driven off the descriptors.
 *
 * Sixteen tables, one query builder. The alternative — sixteen hand-written statements —
 * is sixteen chances for a `WHERE` clause to disagree with the descriptor that documents
 * it, and a scope clause that is one table too generous is a cross-account data leak, not
 * a bug. So the scope is *derived*: `AccountScope` already says how each table hangs off
 * the account, and this file turns that into SQL by walking the same chain the importer
 * walks in reverse.
 *
 * What is not derivable is `rowFilter`, which the descriptors state as prose. Those live in
 * {@link ROW_FILTER_SQL}, keyed by table name and total over the domain — every brain table
 * has an entry, `null` where it has no predicate — so adding a table to `tables.ts` without
 * deciding its filter fails `tests/backup-account-brain-source.test.ts` rather than quietly
 * exporting every row of it.
 *
 * **Read twice.** The measuring pass and the streaming pass both call `rows()` for every
 * table, and `export-brain.ts` compares the second walk against the INDEX the first one
 * committed to. Two things make the two walks agree:
 *
 *   - **A stable total order.** Keyset pagination on the primary key, or on the row-value
 *     pair `(memory_id, tag_id)` for the one table without one. Not a held cursor: that
 *     needs a transaction open for the whole download, and this pool is `max: 10` behind
 *     PgBouncer in transaction mode.
 *   - **A fixed horizon.** `created_at <= startedAt`, captured once when the source is
 *     constructed, so a memory written while the archive streams is invisible to both
 *     passes instead of appearing in the second one and failing the comparison.
 *
 * `memory_tag_map` has no `created_at`, so it has no horizon: tagging a memory mid-export
 * inserts a row into the middle of the ordering, the second pass sees it, and the download
 * ends as `AccountBackupChangedError` — a 409 whose advice is "run it again". That is
 * honest and it is rare, and the alternative is carrying a tag map that does not match the
 * tags beside it.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §6.4.
 */

import { sql, type SQL } from "drizzle-orm";

import { db } from "@/shared/infrastructure/db";
import {
  accountTable,
  accountTables,
  carriedColumns,
  type AccountTable,
} from "@backup/account/domain/tables";
import type { BrainExportSource } from "@backup/account/application/export-types";

/** Rows per round trip. One page of a brain table is tens of kilobytes. */
const PAGE_ROWS = 500;

/**
 * How deep a `via: "parent"` chain may go before it is treated as a descriptor bug.
 *
 * The real chains are two links long (`memory_versions` → `memories` → `brains` → a
 * column). A guard rather than a proof because the failure mode without one is infinite
 * recursion inside a request, which is a hung worker rather than an error.
 */
const MAX_SCOPE_DEPTH = 8;

/**
 * Each brain table's `rowFilter`, as SQL.
 *
 * Total over the domain on purpose: `null` means "the descriptor states no predicate", and
 * the absence of a key means someone added a table and did not think about it.
 *
 * Exported because it is the definition of "a row this archive carries", and one other module
 * has to agree with it: the `/backup` card's own counts. `tests/backup-overview-scope.test.ts`
 * reads the two predicates back and compares them, which is the check that was missing when the
 * card reported nine memories for an account whose archive would have carried three.
 */
export const ROW_FILTER_SQL: Record<string, ((userId: string) => SQL) | null> = {
  // "every brain the account owns, archived ones included" — no predicate.
  brains: null,
  brain_agents: null,
  brain_projects: null,
  brain_entities: null,
  /** Live memories only: a Recycle Bin that travelled would restore as content. */
  memories: () => sql`"deleted_at" IS NULL`,
  memory_versions: null,
  memory_tags: null,
  memory_tag_map: null,
  brain_relationships: null,
  memory_links: null,
  memory_mentions: null,
  brain_review_items: null,
  /**
   * Grants to the account's own agents, and nothing else. A grant to another account is
   * that account's data (§1.1); a grant to the owner is what `brains.owner_user_id`
   * already says. The agent subquery is built from `brain_agents`' own descriptor rather
   * than spelled here, so it cannot drift from the scope that table exports under.
   */
  brain_access: (userId) =>
    sql`"principal_type" = 'agent' AND "principal_id" IN (${scopeSelect(
      accountTable("brain", "brain_agents", "brain source"),
      userId,
      0
    )})`,
};

/** `SELECT "id" FROM <parent> WHERE <the parent's own scope and filter>`. */
function scopeSelect(table: AccountTable, userId: string, depth: number): SQL {
  return sql`SELECT ${sql.identifier("id")} FROM ${sql.identifier(table.name)} WHERE ${rowScope(
    table,
    userId,
    depth
  )}`;
}

/**
 * "This row belongs to this account", as a predicate.
 *
 * A `column` scope is one comparison. A `parent` scope is an `IN (SELECT id …)` against the
 * parent's own predicate — recursion, so `memory_versions` is scoped by the memories that
 * are scoped by the brains that are scoped by `owner_user_id`, and no intermediate step is
 * ever spelled twice. A semi-join rather than a materialized id list because a brain can
 * hold a hundred thousand memories and the planner is better at this than we are.
 */
function scopePredicate(table: AccountTable, userId: string, depth: number): SQL {
  if (depth > MAX_SCOPE_DEPTH) {
    throw new Error(`${table.name} scope nests deeper than ${MAX_SCOPE_DEPTH} parents`);
  }
  const scope = table.scope;
  if (scope.via === "column") {
    return sql`${sql.identifier(scope.column)} = ${userId}`;
  }
  const parent = accountTable(table.domain, scope.table, "brain source");
  return sql`${sql.identifier(scope.column)} IN (${scopeSelect(parent, userId, depth + 1)})`;
}

/** The scope, the descriptor's row filter, and the horizon — everything but the keyset. */
function rowScope(table: AccountTable, userId: string, depth: number): SQL {
  const parts: SQL[] = [sql`(${scopePredicate(table, userId, depth)})`];

  const filter = ROW_FILTER_SQL[table.name];
  if (filter === undefined) {
    throw new Error(`${table.name} has no row filter decision in brain-source.ts`);
  }
  if (filter !== null) parts.push(sql`(${filter(userId)})`);

  return sql.join(parts, sql` AND `);
}

/**
 * The columns the rows are ordered and paginated by.
 *
 * The primary key where there is one. `memory_tag_map` is the exception — two references
 * and nothing else — and its references are exactly its composite key, so the pair is both
 * unique and stable. Derived from the descriptor rather than listed here so a new id-less
 * table gets the same treatment without an edit.
 */
function orderColumns(table: AccountTable): string[] {
  const own = Object.entries(table.columns)
    .filter(([, rule]) => rule.rule === "id")
    .map(([column]) => column);
  if (own.length > 0) return own;

  const refs = Object.entries(table.columns)
    .filter(([, rule]) => rule.rule === "ref")
    .map(([column]) => column);
  if (refs.length === 0) {
    throw new Error(`${table.name} has no stable order: no id and no references`);
  }
  return refs;
}

/** `("memory_id", "tag_id") > ($1, $2)` — a row-value comparison, so one page cannot repeat. */
function keysetPredicate(columns: readonly string[], cursor: readonly unknown[]): SQL {
  const left = sql.join(
    columns.map((column) => sql.identifier(column)),
    sql`, `
  );
  const right = sql.join(
    cursor.map((value) => sql`${value}`),
    sql`, `
  );
  return sql`(${left}) > (${right})`;
}

export function drizzleBrainSource(userId: string, startedAt: Date): BrainExportSource {
  async function* rows(table: AccountTable): AsyncIterable<Record<string, unknown>> {
    if (table.domain !== "brain") {
      throw new Error(`${table.name} is not a brain table`);
    }

    const order = orderColumns(table);
    const orderBy = sql.join(
      order.map((column) => sql`${sql.identifier(column)} ASC`),
      sql`, `
    );
    const columns = sql.join(
      carriedColumns(table).map((column) => sql.identifier(column)),
      sql`, `
    );
    // No `created_at` means no horizon — see this file's header for what that costs.
    //
    // The instant travels as its own ISO string, cast in the statement. A raw `${startedAt}`
    // reads correctly and cannot be sent: a bare value in a `sql` template has no column to
    // ask how to encode it, so postgres-js is handed a `Date` where it wants a string and
    // throws `ERR_INVALID_ARG_TYPE` — which killed the first page of the first table and
    // with it every Brain download. `tests/backup-sql-driver-params.test.ts` holds the line.
    const horizon =
      "created_at" in table.columns
        ? sql`(${sql.identifier("created_at")} <= ${startedAt.toISOString()}::timestamptz)`
        : null;

    let cursor: unknown[] | null = null;
    for (;;) {
      const where: SQL[] = [rowScope(table, userId, 0)];
      if (horizon !== null) where.push(horizon);
      if (cursor !== null) where.push(keysetPredicate(order, cursor));

      const query = sql`SELECT ${columns} FROM ${sql.identifier(table.name)} WHERE ${sql.join(
        where,
        sql` AND `
      )} ORDER BY ${orderBy} LIMIT ${PAGE_ROWS}`;

      const page = (await db.execute(query)) as unknown as Record<string, unknown>[];
      for (const row of page) yield row;

      if (page.length < PAGE_ROWS) return;
      const last = page[page.length - 1];
      cursor = order.map((column) => last[column]);
    }
  }

  return { rows };
}

/** The table names this file has decided a filter for, for the drift test. */
export function brainRowFilterNames(): string[] {
  return Object.keys(ROW_FILTER_SQL);
}

/** The brain tables the descriptors declare, for the same test. */
export function brainTableNames(): string[] {
  return accountTables("brain").map((table) => table.name);
}

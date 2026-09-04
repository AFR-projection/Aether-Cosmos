/**
 * `BrainImportSink` over this application's own tables — sixteen of them, one INSERT builder.
 *
 * Everything that *decides* anything has already happened by the time a row arrives here:
 * ids minted, references remapped, owner columns overwritten with the authenticated caller,
 * CHECK constraints evaluated, timestamps clamped. So this file is a translator and nothing
 * more, and it has exactly two jobs worth the words below.
 *
 * **It runs inside the caller's transaction.** The handle is an argument, never `db`: the
 * whole brain import is one transaction opened by `brainRestoreSession`, and MVCC is what
 * makes staging unnecessary — uncommitted rows are invisible to every other session, and a
 * `ROLLBACK` erases them with no sweeper and no `deleted_at` bookkeeping. A statement here
 * that reached for the module-level `db` would run outside that transaction and survive the
 * rollback, which is the one failure this design cannot express anywhere else.
 *
 * **It goes through Drizzle rather than raw SQL.** The export side reads with `sql` templates
 * because a SELECT of quoted identifiers needs no type knowledge; an INSERT does. `jsonb`
 * columns want `JSON.stringify`, `vector` columns want their own literal, `timestamptz` wants
 * an ISO string, and postgres.js infers *none* of that from a plain object — it would send
 * `[object Object]`. Drizzle's own column mappers already know each of those, so the rows are
 * re-keyed from SQL names to Drizzle property names and handed over. The one thing this costs
 * is a name map per table, which `schema-map.ts` builds once from `getTableColumns`.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.4, §11.
 */

import { and, eq, notInArray, sql } from "drizzle-orm";

import { brains } from "@/shared/infrastructure/db/schema";
import { AfrCorruptError } from "@backup/account/domain/errors";
import type { AccountTable } from "@backup/account/domain/tables";
import type { BrainImportSink } from "@backup/account/application/import-types";
import {
  columnKeys,
  realColumn,
  realTable,
  type AccountTx,
} from "@backup/account/infrastructure/schema-map";

/** Rows per `UPDATE … FROM (VALUES …)` in the self-reference pass. */
const RELINK_CHUNK = 1_000;

/**
 * One row, re-keyed onto Drizzle's property names.
 *
 * A key the table does not have is a descriptor bug rather than hostile input — the mapper
 * only ever writes columns `tables.ts` declares, and the test suite proves the descriptors
 * and the schema agree — but it is caught here anyway, because the alternative is Drizzle
 * silently dropping the key and a column arriving as its default.
 */
function reKey(table: AccountTable, row: Record<string, unknown>): Record<string, unknown> {
  const keys = columnKeys(table.name);
  const mapped: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    const key = keys.get(column);
    if (key === undefined) {
      throw new Error(`${table.name} has no column named ${column}`);
    }
    mapped[key] = value;
  }
  return mapped;
}

/**
 * A Postgres complaint about the *content* of a row, as refusal #7.
 *
 * `23xxx` is an integrity violation and `22xxx` is a data exception: a reference the archive
 * spelled for a row it does not contain, a duplicate the mapper's own dedupe key did not
 * catch, a string longer than its column, a number outside its range. Every one of those is
 * a statement about the archive, so it is damage, and a 422 that says so is more useful than
 * the 500 an untranslated driver error becomes.
 *
 * **Only the constraint's name travels.** Postgres puts the offending values in `detail` and
 * often in `message` — `Key (dedupe_key)=(…) already exists` — and those values are the
 * user's own content, which §12 does not allow into a refusal string or a log line.
 *
 * Anything else propagates untouched: a connection reset, a deadlock, a statement timeout are
 * all "try again", not "your backup is broken".
 */
function translate(error: unknown, where: string): unknown {
  const shaped = error as { code?: unknown; constraint_name?: unknown; column_name?: unknown };
  const code = typeof shaped?.code === "string" ? shaped.code : "";
  if (!code.startsWith("23") && !code.startsWith("22")) return error;

  const label =
    typeof shaped.constraint_name === "string" && shaped.constraint_name.length > 0
      ? shaped.constraint_name
      : typeof shaped.column_name === "string" && shaped.column_name.length > 0
        ? shaped.column_name
        : "no constraint named";
  return new AfrCorruptError(`${where} violates ${label} (${code})`);
}

/**
 * @param doomedBrainIds brains a `replace` is about to delete — see {@link drizzleBrainSink}.
 */
export function drizzleBrainSink(input: {
  tx: AccountTx;
  ownerUserId: string;
  doomedBrainIds?: readonly string[];
}): BrainImportSink {
  const { tx, ownerUserId } = input;
  const doomed = input.doomedBrainIds ?? [];

  async function hasDefaultBrain(): Promise<boolean> {
    // Inside the transaction on purpose: a brain this same import inserted a moment ago must
    // count, or the second archive brain would also claim `is_default` and collide with
    // `brains_owner_default_unique`.
    //
    // `doomed` is what makes the answer right under `replace`. The old rows are still there —
    // they are deleted at stage 5, never before — so a plain count would say "yes, there is a
    // default already", every arriving brain would come in with the flag false, and the account
    // would finish the restore with no default brain at all.
    const [row] = await tx
      .select({ id: brains.id })
      .from(brains)
      .where(
        and(
          eq(brains.ownerUserId, ownerUserId),
          eq(brains.isDefault, true),
          ...(doomed.length > 0 ? [notInArray(brains.id, [...doomed])] : [])
        )
      )
      .limit(1);
    return row !== undefined;
  }

  async function insert(
    table: AccountTable,
    rows: readonly Record<string, unknown>[]
  ): Promise<void> {
    if (rows.length === 0) return;
    const values = rows.map((row) => reKey(table, row));
    try {
      // Heterogeneous keys are Drizzle's business and it handles them: it walks the table's
      // own columns and writes `DEFAULT` where a row has no value, which is exactly what a
      // `time` column the archive did not carry should become.
      await tx.insert(realTable(table.name)).values(values);
    } catch (error) {
      throw translate(error, `${table.name} batch of ${rows.length}`);
    }
  }

  async function relink(
    table: AccountTable,
    column: string,
    pairs: readonly { id: string; value: string }[]
  ): Promise<void> {
    if (pairs.length === 0) return;

    const target = realTable(table.name);
    const idColumn = realColumn(table.name, "id");
    const refColumn = realColumn(table.name, column);
    const cast = sql.raw(refColumn.getSQLType());

    for (let i = 0; i < pairs.length; i += RELINK_CHUNK) {
      const chunk = pairs.slice(i, i + RELINK_CHUNK);
      // One statement per chunk rather than one per pair: a hundred thousand memories with a
      // successor is a hundred thousand round trips otherwise, all inside one transaction.
      const tuples = sql.join(
        chunk.map((pair) => sql`(${pair.id}::${cast}, ${pair.value}::${cast})`),
        sql`, `
      );
      try {
        await tx.execute(
          sql`UPDATE ${target} SET ${sql.identifier(column)} = "afr_relink"."value" FROM (VALUES ${tuples}) AS "afr_relink"("id", "value") WHERE ${idColumn} = "afr_relink"."id"`
        );
      } catch (error) {
        throw translate(error, `${table.name}.${column} relink of ${chunk.length}`);
      }
    }
  }

  return { hasDefaultBrain, insert, relink };
}

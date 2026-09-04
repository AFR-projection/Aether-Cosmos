/**
 * Stage 5 for Brain: the only `DELETE` the feature issues, and how it knows what is old.
 *
 * The Brain domain cannot stage the way Files does. There is no `restore_batch_id` column on
 * thirteen brain tables and adding one would be a migration across all of them — but it does
 * not need one, because the whole brain import runs inside a single transaction and MVCC
 * already makes uncommitted rows invisible to everyone else. So `replace` deletes the old rows
 * in that same transaction (§7.3), which is what makes it atomic: either the account ends the
 * statement with the archive's brains and none of the old ones, or the transaction rolls back
 * and it still has exactly what it had. Test #33 in §16 is precisely that — fail after the
 * `DELETE` and the old rows come back intact.
 *
 * **Two things decide correctness here, and neither is a cascade.**
 *
 * *What counts as old* is answered by {@link snapshotBrainRoots}, called at the start of the
 * import, before a single row is written. An account's brains and agents are dozens of rows,
 * so their ids fit in memory; everything else in the domain hangs off one of those two roots
 * and is reached by a semi-join rather than by an id list. Snapshotting beforehand — rather
 * than excluding the ids the batch minted afterwards — means a brain created by some other
 * request while the restore is running is not in the set, so `replace` cannot delete something
 * it never saw. That is the failure direction to prefer.
 *
 * *What order rows leave in* is strict reverse insert rank, and the deletes are explicit
 * rather than left to `ON DELETE CASCADE`. A cascade is a fact about the schema, and this file
 * would then be silently wrong the day a foreign key is declared without one; walking
 * `accountTables("brain")` backwards is a fact about this feature's own descriptor, which
 * `assertInsertOrder()` already proves is a valid topological order. It also keeps every
 * destructive statement visible in the one file §16.1's structural test reads.
 *
 * Nothing here is soft: a deleted memory is gone, unlike a replaced file, which lands in the
 * Recycle Bin. That asymmetry is the schema's — `memories.deleted_at` exists but no brain UI
 * offers a bin to restore from, so a soft delete would be a row nobody can ever see again
 * rather than an undo. It is why §7.4 makes the confirmation for a brain `replace` the strict
 * one, and why the step-code gate is required on that route.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §7.4, §16.
 */

import { eq, inArray, sql, type SQL } from "drizzle-orm";

import {
  accountTables,
  findAccountTable,
  type AccountTable,
} from "@backup/account/domain/tables";
import {
  realColumn,
  realTable,
  type AccountTx,
} from "@backup/account/infrastructure/schema-map";

/** Ids per statement — so a large account is chunks of parameters rather than one huge list. */
const DELETE_CHUNK = 500;

/**
 * The account's brain roots as they were before the import wrote anything.
 *
 * Keyed by table name so {@link deleteOldBrainRows} can find the root of any chain by walking
 * the descriptor, rather than by hard-coding which two tables happen to be roots today.
 */
export type BrainRootSnapshot = ReadonlyMap<string, readonly string[]>;

/** How many rows a `replace` removed, per table, for the audit row §13 asks for. */
export interface BrainDeleteResult {
  readonly deletedByTable: ReadonlyMap<string, number>;
  readonly deletedRows: number;
}

/**
 * Read the ids of every root row this account owns, inside the import's transaction.
 *
 * Called before the first insert. Cheap by construction — two `SELECT id` over an index — and
 * the result is the *definition* of "old" for the rest of the restore.
 */
export async function snapshotBrainRoots(input: {
  tx: AccountTx;
  ownerUserId: string;
}): Promise<BrainRootSnapshot> {
  const { tx, ownerUserId } = input;
  const snapshot = new Map<string, readonly string[]>();

  for (const table of accountTables("brain")) {
    if (table.scope.via !== "column") continue;
    const rows = await tx
      .select({ id: realColumn(table.name, "id") })
      .from(realTable(table.name))
      .where(eq(realColumn(table.name, table.scope.column), ownerUserId));
    snapshot.set(
      table.name,
      rows.map((row) => String(row.id))
    );
  }

  return snapshot;
}

/** The root table a brain table's scope chain ends at. */
function rootOf(table: AccountTable): AccountTable {
  let current = table;
  for (let hops = 0; hops <= accountTables("brain").length; hops++) {
    if (current.scope.via === "column") return current;
    const parent = findAccountTable("brain", current.scope.table);
    if (parent === undefined) break;
    current = parent;
  }
  // Unreachable: `assertInsertOrder()` proves every parent is carried and ranks strictly lower,
  // so the chain terminates. A plain `Error` because this would be a bug in `tables.ts`, and a
  // descriptor bug must never be reportable as a corrupt-archive refusal.
  throw new Error(`${table.name} has no owner-scoped root`);
}

/**
 * `WHERE` for one table, restricted to the chain rooted at `ids`.
 *
 * For a root table this is `id IN (…)` *and* the owner column: the ids came from a query this
 * file ran a moment ago, but scoping every destructive statement by the authenticated owner is
 * the discipline §10 asks for, and it costs one `AND`.
 *
 * For a child it is `<column> IN (SELECT id FROM <parent> WHERE <the parent's own predicate>)`,
 * recursively — two levels at the deepest point of this schema (`memory_versions` → `memories`
 * → `brains`), and being a recursion means a third level added later needs no code here.
 */
function scopedWhere(table: AccountTable, ownerUserId: string, ids: readonly string[]): SQL {
  if (table.scope.via === "column") {
    const owner = eq(realColumn(table.name, table.scope.column), ownerUserId);
    return sql`${owner} AND ${inArray(realColumn(table.name, "id"), [...ids])}`;
  }

  const parent = rootOrParent(table.scope.table);
  return sql`${realColumn(table.name, table.scope.column)} IN (SELECT ${realColumn(parent.name, "id")} FROM ${realTable(parent.name)} WHERE ${scopedWhere(parent, ownerUserId, ids)})`;
}

function rootOrParent(name: string): AccountTable {
  const parent = findAccountTable("brain", name);
  if (parent === undefined) {
    throw new Error(`brain scope chain names ${name}, which no brain backup carries`);
  }
  return parent;
}

/**
 * Remove everything that hung off the snapshotted roots.
 *
 * Runs after the import has handed over its last row and after stage 4 has verified the
 * payload digest — never before, because a restore that fails anywhere must have deleted
 * nothing (§7.4). The caller commits the transaction; this function only removes rows from it.
 */
export async function deleteOldBrainRows(input: {
  tx: AccountTx;
  ownerUserId: string;
  snapshot: BrainRootSnapshot;
}): Promise<BrainDeleteResult> {
  const { tx, ownerUserId, snapshot } = input;
  const deletedByTable = new Map<string, number>();
  let deletedRows = 0;

  // Reverse insert rank: a row leaves only once nothing that references it remains.
  for (const table of [...accountTables("brain")].reverse()) {
    const ids = snapshot.get(rootOf(table).name) ?? [];
    if (ids.length === 0) continue;

    const target = realTable(table.name);
    let removed = 0;
    for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
      const chunk = ids.slice(i, i + DELETE_CHUNK);
      const result = await tx.delete(target).where(scopedWhere(table, ownerUserId, chunk));
      removed += rowCount(result);
    }

    deletedByTable.set(table.name, removed);
    deletedRows += removed;
  }

  return { deletedByTable, deletedRows };
}

/**
 * How many rows a statement touched, across the shapes this driver returns.
 *
 * postgres.js resolves a `DELETE` to a `RowList` carrying a `count`; Drizzle wraps some
 * statements as `{ rowCount }`. Neither is worth depending on for correctness — the number only
 * ever reaches an audit row — so an unrecognised shape reports 0 rather than throwing.
 */
function rowCount(result: unknown): number {
  const shaped = result as { count?: unknown; rowCount?: unknown };
  if (typeof shaped?.count === "number") return shaped.count;
  if (typeof shaped?.rowCount === "number") return shaped.rowCount;
  return 0;
}

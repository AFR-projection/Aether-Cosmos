/**
 * The Drizzle schema, addressable by the names the archive uses.
 *
 * `tables.ts` names tables and columns the way SQL does, because that is the name the INDEX
 * carries and the name `table-classification.ts` uses. Drizzle's exports are camelCase. Two
 * files now need to cross that gap — the sink, to hand rows to Drizzle's own column mappers,
 * and `commit-brain.ts`, to build a `DELETE` against a table it was handed by name — so the
 * lookup lives here rather than being written twice with two different opinions about a
 * missing name.
 *
 * The map is built by walking the schema module rather than by listing sixteen tables, which
 * is the difference between a rename being caught by the type checker and a rename silently
 * producing an empty lookup.
 *
 * Everything here throws a plain `Error`, never a refusal: a name that is not in the schema
 * is a bug in the descriptors, and by the time any of this runs `index-entries.ts` has already
 * refused every table name the descriptors do not carry. A damaged archive cannot reach it.
 */

import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@/shared/infrastructure/db/schema";

/**
 * A transaction handle, spelled the way the rest of this codebase spells one.
 *
 * It lives here because four modules in this folder take one — the brain sink, both commit
 * halves, the ledger — and `db.transaction` hands its callback the same type as `db` itself,
 * so a function that accepts this can be driven by either. Naming it once means a files
 * module never has to import a type called `BrainTx` from the brain sink to say "transaction".
 */
export type AccountTx = PostgresJsDatabase<typeof schema>;

/** Every `pgTable` the application defines, by SQL name. */
const byName = new Map<string, PgTable>(
  (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => [getTableName(table), table] as const)
);

/** SQL column name → Drizzle property key, per table. Built once, reused per batch. */
const keyCache = new Map<string, ReadonlyMap<string, string>>();
/** SQL column name → the column itself, per table. Same cache discipline. */
const columnCache = new Map<string, ReadonlyMap<string, PgColumn>>();

export function realTable(name: string): PgTable {
  const table = byName.get(name);
  if (table === undefined) {
    throw new Error(`schema.ts defines no table named ${name}`);
  }
  return table;
}

function columnsOf(name: string): ReadonlyMap<string, PgColumn> {
  const cached = columnCache.get(name);
  if (cached !== undefined) return cached;

  const built = new Map<string, PgColumn>();
  for (const column of Object.values(getTableColumns(realTable(name)))) {
    built.set((column as PgColumn).name, column as PgColumn);
  }
  columnCache.set(name, built);
  return built;
}

/** SQL name → Drizzle property key, for re-keying a row onto `.values()`. */
export function columnKeys(name: string): ReadonlyMap<string, string> {
  const cached = keyCache.get(name);
  if (cached !== undefined) return cached;

  const built = new Map<string, string>();
  for (const [key, column] of Object.entries(getTableColumns(realTable(name)))) {
    built.set((column as PgColumn).name, key);
  }
  keyCache.set(name, built);
  return built;
}

/** One column, by the name SQL knows it as. */
export function realColumn(table: string, column: string): PgColumn {
  const found = columnsOf(table).get(column);
  if (found === undefined) {
    throw new Error(`${table} has no column named ${column}`);
  }
  return found;
}

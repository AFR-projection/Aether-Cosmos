import { getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  ALL_TABLES,
  BRAIN_TABLES,
  CORE_TABLES,
  DERIVED_TABLES,
  FILES_TABLES,
  NEVER_TABLES,
  TABLE_CLASSES,
  classifyTable,
  type TableClass,
} from "@backup/domain/table-classification";

/**
 * The table classification, checked against the schema rather than against itself.
 *
 * This is the test that decides whether the next migration is safe. A table added to
 * `schema.ts` and not to a class is a table nobody decided the backup story for — and
 * the per-account archive's own coverage test measures itself against two of these
 * lists, so an unclassified table is invisible to that test too.
 *
 * The second half is the foreign-key closure: Files and Brain can only be separate
 * archives if a Files row never points at a Brain row. If one did, restoring Files alone
 * would leave a dangling reference no amount of care in the importer could fix.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §1.1, §5.3.
 */

/**
 * Every `pgTable` the application defines, by its SQL name.
 *
 * The `unknown[]` widening is what makes the predicate legal: `Object.values` on a
 * namespace import types each entry as its own literal table (or `PgEnum`), and a
 * predicate narrowing to the generic `PgTable` is not assignable to
 * `PgTableWithColumns<{ name: "restore_batches"; … }>` — `_.config.name` is `string`
 * on one side and a string literal on the other. Widening first asks the same
 * question of a type broad enough to answer it; `is()` is still the runtime check.
 */
const schemaTables = (Object.values(schema) as unknown[]).filter(
  (value): value is PgTable => is(value, PgTable)
);
const schemaTableNames = schemaTables.map((table) => getTableName(table)).sort();

const CLASS_OF = new Map<string, TableClass>();
for (const [cls, tables] of Object.entries(TABLE_CLASSES) as [
  TableClass,
  readonly string[],
][]) {
  for (const table of tables) CLASS_OF.set(table, cls);
}

describe("every table in the schema is classified exactly once", () => {
  it("has no table the classification has never heard of", () => {
    const unclassified = schemaTableNames.filter((name) => !CLASS_OF.has(name));

    // If this fails, a migration added a table and nobody decided which domain owns
    // it. The fix is a line in table-classification.ts, not a change here.
    expect(unclassified).toEqual([]);
  });

  it("has no classified table that the schema does not define", () => {
    const defined = new Set(schemaTableNames);
    const phantom = ALL_TABLES.filter((name) => !defined.has(name));

    expect(phantom).toEqual([]);
  });

  it("puts no table in two classes", () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const name of ALL_TABLES) {
      if (seen.has(name)) duplicated.push(name);
      seen.add(name);
    }

    expect(duplicated).toEqual([]);
    expect(ALL_TABLES).toHaveLength(seen.size);
  });

  it("accounts for all 49 tables in the documented split", () => {
    // The numbers are in the design (§1.1) and are asserted here so that a change to
    // either the schema or the split has to be deliberate.
    expect(CORE_TABLES).toHaveLength(8);
    expect(FILES_TABLES).toHaveLength(8);
    expect(BRAIN_TABLES).toHaveLength(15);
    expect(DERIVED_TABLES).toHaveLength(4);
    // 10 + `backup_keys` + the three per-account tables added by 0028, none of which a
    // restore may write, for the reasons spelled out in table-classification.ts.
    expect(NEVER_TABLES).toHaveLength(14);
    expect(ALL_TABLES).toHaveLength(49);
    expect(schemaTableNames).toHaveLength(49);
  });

  it("classifies a name it does not know as nothing at all", () => {
    expect(classifyTable("users")).toBe("core");
    expect(classifyTable("memories")).toBe("brain");
    expect(classifyTable("file_contents")).toBe("files");
    expect(classifyTable("memory_derived_links")).toBe("derived");
    expect(classifyTable("sessions")).toBe("never");
    // Not a guess and not a throw: an unknown table belongs to no archive, which is the
    // safe direction.
    expect(classifyTable("something_new")).toBeNull();
    expect(classifyTable("")).toBeNull();
  });

  it("keeps the two domains disjoint from each other and from core", () => {
    // What makes `.afrbak` two archives rather than one with a filter: the lists the
    // per-account coverage test reads cannot overlap, or a table would be carried twice.
    for (const [a, b] of [
      [FILES_TABLES, BRAIN_TABLES],
      [FILES_TABLES, CORE_TABLES],
      [BRAIN_TABLES, CORE_TABLES],
    ] as const) {
      expect(a.filter((name) => (b as readonly string[]).includes(name))).toEqual([]);
    }
  });
});

interface Edge {
  from: string;
  to: string;
  columns: string;
}

/** Every foreign key in the schema, as class-to-class edges. */
const edges: Edge[] = schemaTables.flatMap((table) => {
  const config = getTableConfig(table);
  return config.foreignKeys.map((fk) => {
    const reference = fk.reference();
    return {
      from: getTableName(table),
      to: getTableName(reference.foreignTable as PgTable),
      columns: reference.columns.map((column) => column.name).join(", "),
    };
  });
});

describe("the foreign keys do not cross the domain boundary", () => {
  it("found the schema's foreign keys at all", () => {
    // Guards the two tests below: a refactor that stopped reporting edges would make
    // them pass by finding nothing.
    expect(edges.length).toBeGreaterThan(20);
    expect(edges.some((edge) => edge.from === "files" && edge.to === "users")).toBe(true);
  });

  it("has no Files table pointing at a Brain table, or the reverse", () => {
    const crossings = edges.filter((edge) => {
      const from = CLASS_OF.get(edge.from);
      const to = CLASS_OF.get(edge.to);
      return (
        (from === "files" && to === "brain") || (from === "brain" && to === "files")
      );
    });

    // Restoring one domain alone has to leave a consistent database. A single edge
    // here would mean it cannot.
    expect(crossings.map((edge) => `${edge.from}.${edge.columns} -> ${edge.to}`)).toEqual([]);
  });

  it("has no domain table depending on a table no artifact carries", () => {
    const dangling = edges.filter((edge) => {
      const from = CLASS_OF.get(edge.from);
      const to = CLASS_OF.get(edge.to);
      if (from !== "files" && from !== "brain") return false;
      // Core rides in both artifacts; a domain table may also point within its own
      // class. Anything else is a reference to rows the restore will not have.
      return to !== "core" && to !== from;
    });

    expect(dangling.map((edge) => `${edge.from}.${edge.columns} -> ${edge.to}`)).toEqual([]);
  });
});

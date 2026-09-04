import { getTableName, is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "@/shared/infrastructure/db/schema";
import {
  BRAIN_TABLES as BRAIN_CLASS,
  FILES_TABLES as FILES_CLASS,
} from "@backup/domain/table-classification";
import {
  EXCLUDED_ACCOUNT_TABLES,
  NOTE_BODY_KEYS,
  accountTable,
  accountTables,
  assertInsertOrder,
  carriedColumns,
  droppedColumns,
  excludedAccountTables,
  findAccountTable,
  insertRankOf,
  refsOf,
  type AccountTable,
  type ColumnRule,
} from "@backup/account/domain/tables";
import { AccountBackupError, AfrCorruptError } from "@backup/account/domain/errors";
import type { BackupDomain } from "@backup/domain/types";

const WHERE = "index line 7";

/**
 * TABLES — the descriptor checked against the schema rather than against itself.
 *
 * This is the test that decides whether the next migration is safe. The descriptor says what
 * a per-account archive carries and what a restore does with each column; nothing stops it
 * from going quietly out of date except reading the real `pgTable` definitions here. A column
 * added to `memories` and not to the descriptor fails the first test in this file, which is
 * the only place that failure is cheap — the alternatives are a backup that silently omits a
 * field, or an INSERT that names a column Postgres refuses.
 *
 * The second half proves the two properties the importer is built on: every id is reissued
 * rather than trusted, and every reference points at a table inserted earlier.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §1.1, §5.3,
 * §7.3, §11, §17.
 */

/** Every `pgTable` the application defines, by its SQL name. See the note in
 * `tests/backup-table-classification.test.ts` for why the widening is necessary. */
const schemaTables = new Map<string, PgTable>(
  (Object.values(schema) as unknown[])
    .filter((value): value is PgTable => is(value, PgTable))
    .map((table) => [getTableName(table), table] as const)
);

const CARRIED: readonly AccountTable[] = [...accountTables("files"), ...accountTables("brain")];

function realTable(name: string): PgTable {
  const table = schemaTables.get(name);
  if (!table) throw new Error(`schema.ts defines no table named ${name}`);
  return table;
}

/** The real columns, keyed by SQL name — which is how the descriptor spells them. */
function realColumns(name: string) {
  return new Map(
    getTableConfig(realTable(name)).columns.map((column) => [column.name, column] as const)
  );
}

/** Single-column foreign keys of one table: local column name → target table name. */
function foreignKeys(name: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const fk of getTableConfig(realTable(name)).foreignKeys) {
    const reference = fk.reference();
    const target = getTableName(reference.foreignTable as PgTable);
    for (const column of reference.columns) keys.set(column.name, target);
  }
  return keys;
}

/** The reason, which lives in `detail`; `message` is one fixed sentence for every refusal. */
function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

describe("the descriptor and the schema agree, column for column", () => {
  it("found the schema at all", () => {
    // Guards every test below: a refactor that stopped finding tables would make them
    // pass by comparing nothing to nothing.
    expect(schemaTables.size).toBe(49);
    expect(CARRIED).toHaveLength(16);
  });

  for (const table of CARRIED) {
    it(`covers exactly the columns ${table.name} really has`, () => {
      const real = [...realColumns(table.name).keys()].sort();
      const described = Object.keys(table.columns).sort();

      // If this fails, a migration added or removed a column and nobody decided whether a
      // backup carries it. The fix is a rule in tables.ts, not a change here.
      expect(described).toEqual(real);
    });
  }

  it("marks every generated column as generated, and nothing else", () => {
    for (const table of CARRIED) {
      const real = realColumns(table.name);
      for (const [name, rule] of Object.entries(table.columns)) {
        const generated = real.get(name)?.generated !== undefined;
        const marked = rule.rule === "drop" && rule.why === "generated";
        // Postgres refuses an INSERT that names a GENERATED ALWAYS column at all, so
        // getting this wrong is not a lost field — it is every restore failing.
        expect(marked, `${table.name}.${name}`).toBe(generated);
      }
    }
  });

  it("keeps a rule's nullability and the column's in step", () => {
    for (const table of CARRIED) {
      const real = realColumns(table.name);
      for (const [name, rule] of Object.entries(table.columns)) {
        if (rule.rule !== "ref" && rule.rule !== "owner") continue;
        const nullable = real.get(name)?.notNull === false;
        // The whole refusal-versus-NULL split rests on this: a dangling nullable `ref`
        // becomes NULL, a dangling non-nullable one is refusal #7. A rule that claims
        // nullability the column does not have would turn a refusal into a crash.
        expect(rule.nullable === true, `${table.name}.${name}`).toBe(nullable);
      }
    }
  });

  it("points every time rule at a real timestamp", () => {
    for (const table of CARRIED) {
      const real = realColumns(table.name);
      for (const [name, rule] of Object.entries(table.columns)) {
        if (rule.rule !== "time") continue;
        expect(real.get(name)?.columnType, `${table.name}.${name}`).toBe("PgTimestamp");
      }
    }
  });

  it("resolves every ref the way the real foreign key does", () => {
    const unenforced: string[] = [];
    for (const table of CARRIED) {
      const keys = foreignKeys(table.name);
      for (const ref of refsOf(table)) {
        const target = keys.get(ref.column);
        if (target === undefined) {
          unenforced.push(`${table.name}.${ref.column}`);
          continue;
        }
        // A `ref` naming a different table than the foreign key would send the importer
        // looking in the wrong id mapping — and find nothing, or worse, find something.
        expect(target, `${table.name}.${ref.column}`).toBe(ref.table);
      }
    }

    // One exception, and it is the polymorphic column: `brain_access.principal_id` holds
    // either a user id or an agent id, so no foreign key can exist. The descriptor calls it
    // a `ref` to `brain_agents` and the row filter keeps only agent grants, which together
    // are what a foreign key would have enforced.
    expect(unenforced).toEqual(["brain_access.principal_id"]);
  });

  it("scopes every table by a column it has, through a table that is carried", () => {
    for (const table of CARRIED) {
      const rule = table.columns[table.scope.column];
      expect(rule, `${table.name}.${table.scope.column}`).toBeDefined();
      if (table.scope.via === "column") {
        // The account's own id, overwritten with the caller's on the way in (§10).
        expect(rule.rule, table.name).toBe("owner");
        expect(foreignKeys(table.name).get(table.scope.column)).toBe("users");
      } else {
        expect(["ref", "server"], table.name).toContain(rule.rule);
        expect(findAccountTable(table.domain, table.scope.table), table.name).toBeDefined();
      }
    }
  });
});

/**
 * Anything that holds a row id of *this* database: the primary key, a foreign key, or a uuid
 * whose name says so. A `text` column named `…_id` is somebody else's label — see the
 * `memories.source_id` assertion below, which is the only one there is.
 */
function idColumns(table: AccountTable): string[] {
  const real = realColumns(table.name);
  const keys = foreignKeys(table.name);
  return Object.keys(table.columns).filter(
    (name) =>
      name === "id" ||
      keys.has(name) ||
      (name.endsWith("_id") && real.get(name)?.columnType === "PgUUID")
  );
}

describe("no id in an archive is ever inserted as a value", () => {
  it("gives every id column a rule that reissues, resolves, or overwrites it", () => {
    const trusted: string[] = [];
    for (const table of CARRIED) {
      for (const name of idColumns(table)) {
        const rule = table.columns[name].rule;
        if (rule === "carry" || rule === "time" || rule === "path" || rule === "payload") {
          trusted.push(`${table.name}.${name}`);
        }
      }
    }

    // The property that makes it impossible for an archive to attach itself to a row it does
    // not contain — including somebody else's row. Every id that exists after a restore is an
    // id that restore issued (§11).
    expect(trusted).toEqual([]);
  });

  it("names the one id-shaped column that is carried verbatim", () => {
    // `memories.source_id` is free text with no foreign key: it records that a memory came
    // out of some conversation, and no mapping in this restore could remap it. Pinned here so
    // that a genuine row reference added later cannot hide behind the same spelling.
    const verbatim = CARRIED.flatMap((table) =>
      Object.entries(table.columns)
        .filter(
          ([name, rule]) =>
            name.endsWith("_id") &&
            rule.rule === "carry" &&
            !foreignKeys(table.name).has(name)
        )
        .map(([name]) => `${table.name}.${name}`)
    );

    expect(verbatim).toEqual(["memories.source_id"]);
    expect(realColumns("memories").get("source_id")?.columnType).toBe("PgText");
  });

  it("carries no ids at all in the files domain, because paths do that work", () => {
    for (const table of accountTables("files")) {
      for (const name of idColumns(table)) {
        // `folders`/`files` rows are found-or-created by walking the entry's path segments,
        // so there is no id mapping to keep: the parent is whatever the path resolved to.
        expect(["owner", "server"], `${table.name}.${name}`).toContain(table.columns[name].rule);
      }
      expect(refsOf(table), table.name).toEqual([]);
    }
  });

  it("reissues the primary key of every brain table that has one", () => {
    for (const table of accountTables("brain")) {
      if (table.name === "memory_tag_map") continue;
      expect(table.columns.id?.rule, table.name).toBe("id");
    }

    // The one table with a composite primary key. It has no id to map, so nothing can point
    // at it — asserted rather than assumed, because a future `ref` to it would resolve
    // against a mapping that will never have an entry.
    expect(realColumns("memory_tag_map").has("id")).toBe(false);
    expect(CARRIED.flatMap(refsOf).some((ref) => ref.table === "memory_tag_map")).toBe(false);
  });
});

describe("what travels, and what is written down as lost", () => {
  it("hands the exporter the archive's own fields and none of the server's", () => {
    const files = carriedColumns(accountTable("files", "files", WHERE));

    // `user_id` and `deleted_at` are the destination's business, `search_vector` is
    // Postgres's, and an exporter that read them would be writing bytes no importer is
    // allowed to trust — which is how a format grows a field that only looks authoritative.
    expect(files).toEqual([
      "name",
      "mime_type",
      "size_bytes",
      "checksum_sha256",
      "created_at",
      "updated_at",
    ]);
    // The brain keeps its source id, because the mapping is keyed by it (§11).
    expect(carriedColumns(accountTable("brain", "memory_tags", WHERE))).toEqual([
      "id",
      "brain_id",
      "name",
      "created_at",
    ]);
  });

  it("explains every admitted loss", () => {
    const unrepresented = CARRIED.flatMap((table) =>
      droppedColumns(table)
        .filter((dropped) => dropped.why === "unrepresented")
        .map((dropped) => ({ ...dropped, table: table.name }))
    );

    // `unrepresented` is the only reason that means "the user loses something". Each one has
    // to carry the sentence that goes in the report; `generated`, `derived`, `core`, and
    // `transient` are all recomputed or meaningless elsewhere and need no apology.
    expect(unrepresented.map((dropped) => `${dropped.table}.${dropped.column}`)).toEqual([
      "files.is_favorite",
      "files.encrypted",
      "files.encryption_meta",
    ]);
    for (const dropped of unrepresented) {
      expect(dropped.note, dropped.column).toBeTruthy();
    }
  });

  it("puts a note on every rule that rewrites or loses information", () => {
    for (const table of CARRIED) {
      for (const [name, rule] of Object.entries(table.columns)) {
        if (rule.rule !== "server") continue;
        // `server` means "the archive's opinion is never read". What the server decides
        // instead is the whole content of that decision, so it is not optional.
        expect(rule.note, `${table.name}.${name}`).toBeTruthy();
      }
    }
  });

  it("carries a note body as the file's own payload, and nothing else that way", () => {
    const payloads = CARRIED.flatMap((table) =>
      Object.entries(table.columns)
        .filter(([, rule]) => rule.rule === "payload")
        .map(([name]) => `${table.name}.${name}`)
    );

    // One entry, one payload: a note's body travels as the bytes of the `file` line that
    // names it, which is why no second INDEX kind was needed for notes.
    expect(payloads).toEqual(["file_contents.content_json", "file_contents.annotations_json"]);
    expect(NOTE_BODY_KEYS.map((key) => `${key}_json`).sort()).toEqual(
      payloads.map((name) => name.split(".")[1]).sort()
    );
  });
});

/** The real registry with one table bent out of shape, to prove the guard is a guard. */
type Registry = Readonly<Record<BackupDomain, readonly AccountTable[]>>;

function bentBrain(name: string, columns: Record<string, ColumnRule>): Registry {
  const brain = accountTables("brain").map((table) =>
    table.name === name ? { ...table, columns: { ...table.columns, ...columns } } : table
  );
  return { files: accountTables("files"), brain };
}

describe("the insert order is a proof, not a comment", () => {
  it("holds for the descriptor as written", () => {
    expect(() => assertInsertOrder()).not.toThrow();
  });

  it("keeps the one self-reference nullable, and knows it is the only one", () => {
    const selfRefs = CARRIED.flatMap((table) =>
      refsOf(table)
        .filter((ref) => ref.table === table.name)
        .map((ref) => ({ ...ref, from: table.name }))
    );

    // A memory superseding another memory is the only cycle in either domain, and the second
    // pass that fills it in is only correct because the column may be NULL in the meantime.
    expect(selfRefs).toEqual([
      { from: "memories", column: "superseded_by_id", table: "memories", nullable: true },
    ]);
  });

  it("catches a reference that points at a table inserted later", () => {
    expect(() =>
      assertInsertOrder(bentBrain("memories", { project_id: { rule: "ref", table: "memory_links" } }))
    ).toThrow(/not lower/);
  });

  it("catches a self-reference that is not nullable", () => {
    // Without the NULL the importer's second pass has nowhere to start: every row in the
    // table would need another row of the same table to exist first.
    expect(() =>
      assertInsertOrder(bentBrain("memories", { superseded_by_id: { rule: "ref", table: "memories" } }))
    ).toThrow(/not lower/);
  });

  it("catches a reference to a table no archive carries", () => {
    expect(() =>
      assertInsertOrder(
        bentBrain("memories", { project_id: { rule: "ref", table: "brain_audit_logs", nullable: true } })
      )
    ).toThrow(/no brain backup carries/);
  });

  it("catches a list whose ranks stopped matching its order", () => {
    const brain = [...accountTables("brain")];
    [brain[3], brain[4]] = [brain[4], brain[3]];

    expect(() => assertInsertOrder({ files: accountTables("files"), brain })).toThrow(
      /ranked 1\.\.13/
    );
  });

  it("catches a table filed under the wrong domain", () => {
    const brain = [accountTables("files")[0], ...accountTables("brain").slice(1)];

    expect(() => assertInsertOrder({ files: accountTables("files"), brain })).toThrow(
      /claims files/
    );
  });

  it("orders the brain the way its dependencies run", () => {
    const rank = (name: string) => insertRankOf("brain", name, WHERE);

    // A memory before the version that records its history, before the link that points at
    // it. The exporter stamps this order into `orderKey`; the importer reads it back.
    expect(rank("brains")).toBeLessThan(rank("memories"));
    expect(rank("memories")).toBeLessThan(rank("memory_versions"));
    expect(rank("memory_versions")).toBeLessThan(rank("memory_links"));
    expect(rank("brain_agents")).toBeLessThan(rank("brain_access"));
  });
});

describe("membership is answered here, not in the byte layout", () => {
  it("finds a table the domain carries", () => {
    expect(accountTable("brain", "memories", WHERE).rank).toBe(5);
    expect(accountTable("files", "file_contents", WHERE).origin).toBe("payload");
    expect(findAccountTable("brain", "memories")?.name).toBe("memories");
  });

  it("refuses a table this domain does not carry, naming the line", () => {
    const detail = detailOf(() => accountTable("brain", "brain_audit_logs", WHERE));

    expect(detail).toContain(WHERE);
    expect(detail).toContain("brain_audit_logs");
    expect(detail).toContain("not carried by a brain backup");
    expect(() => accountTable("brain", "sessions", WHERE)).toThrow(AfrCorruptError);
  });

  it("refuses the other domain's tables, which is what keeps the two archives apart", () => {
    // A brain INDEX line naming `files` is not a brain archive with extra reach; it is an
    // archive trying to write rows the caller asked a different restore to handle.
    expect(() => accountTable("brain", "files", WHERE)).toThrow(AfrCorruptError);
    expect(() => accountTable("files", "memories", WHERE)).toThrow(AfrCorruptError);
    expect(findAccountTable("brain", "folders")).toBeUndefined();
  });

  it("flattens the name before it reaches an operator's log", () => {
    const detail = detailOf(() => accountTable("brain", "memories; drop table users", WHERE));

    expect(detail).toContain("memories??drop?table?users");
    expect(detail).not.toContain(";");
    // Bounded too: a table name is 63 characters at most, and a hostile one is not a name.
    const long = detailOf(() => accountTable("brain", "x".repeat(100), WHERE));
    expect(long).toContain("x".repeat(32));
    expect(long).not.toContain("x".repeat(33));
  });

  it("answers without refusing when the caller only wants to know", () => {
    // `findAccountTable` is the lookup the exporter uses while deciding what to select;
    // there is no hostile input there and nothing to refuse.
    expect(findAccountTable("files", "shares")).toBeUndefined();
    expect(() => findAccountTable("files", "shares")).not.toThrow();
  });
});

describe("carried plus excluded is every table of both domains", () => {
  for (const [domain, classified] of [
    ["files", FILES_CLASS],
    ["brain", BRAIN_CLASS],
  ] as const) {
    it(`accounts for all ${classified.length} ${domain} tables`, () => {
      const carried = accountTables(domain).map((table) => table.name);
      const excluded = excludedAccountTables(domain).map((entry) => entry.name);

      // The point of the exercise: "the backup does not contain X" is discoverable before
      // the disaster rather than after it. A table in neither list would be an omission
      // nobody decided on, which is the failure mode this test exists to prevent.
      expect([...carried, ...excluded].sort()).toEqual([...classified].sort());
      expect(new Set([...carried, ...excluded]).size).toBe(classified.length);
    });
  }

  it("carries the counts the design states", () => {
    expect(accountTables("files")).toHaveLength(3);
    expect(accountTables("brain")).toHaveLength(13);
    expect(excludedAccountTables("files")).toHaveLength(5);
    expect(excludedAccountTables("brain")).toHaveLength(2);
    expect(EXCLUDED_ACCOUNT_TABLES).toHaveLength(7);
  });

  it("gives every omission a reason a user could read", () => {
    for (const entry of EXCLUDED_ACCOUNT_TABLES) {
      expect(schemaTables.has(entry.name), entry.name).toBe(true);
      expect(findAccountTable(entry.domain, entry.name), entry.name).toBeUndefined();
      // Long enough to be a sentence rather than a label. This text reaches the report.
      expect(entry.why.length, entry.name).toBeGreaterThan(60);
    }
  });

  it("keeps the two domains disjoint", () => {
    const files = new Set(accountTables("files").map((table) => table.name));
    for (const table of accountTables("brain")) {
      expect(files.has(table.name), table.name).toBe(false);
      expect(table.domain).toBe("brain");
    }
  });

  it("carries no table that either artifact must never restore", () => {
    // `account_backup_identities` is the sharpest of these: a restored identity row would
    // let an archive be adopted without anyone typing its recovery phrase.
    for (const name of ["users", "sessions", "account_backup_identities", "restore_batches"]) {
      expect(findAccountTable("files", name), name).toBeUndefined();
      expect(findAccountTable("brain", name), name).toBeUndefined();
    }
  });
});

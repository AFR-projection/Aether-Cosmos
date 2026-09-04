/**
 * The brain importer, over fakes: no database, no archive bytes, no keys.
 *
 * `importBrain` is the half of the restore that can do the most damage — it writes rows into
 * thirteen tables from a file the user could have edited — so what is tested here is every
 * decision it makes about a line of NDJSON: which id it issues, which reference it resolves,
 * which column it refuses to take from the archive at all, and which of §7's numbered refusals
 * a malformed archive earns.
 *
 * The two orderings the format promises are load-bearing and are tested as such: rank
 * non-decreasing (so a reference is always already inserted) and `orderKey` ascending (so the
 * INDEX and the payload cannot disagree about which row is which).
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §11.
 */

import { describe, expect, it } from "vitest";

import { importBrain } from "@backup/account/application/import-brain";
import {
  declaredBudget,
  type AfrReadable,
  type BrainImportSink,
  type ImportBudget,
  type RestoreMode,
} from "@backup/account/application/import-types";
import { AfrCorruptError, AfrTooLargeError } from "@backup/account/domain/errors";
import { encodeBrainEntry, type AfrBrainEntry } from "@backup/account/domain/index-entries";
import { ACCOUNT_ROW_CHECKS } from "@backup/account/domain/row-checks";
import type { AfrSummary } from "@backup/account/domain/summary";
import { accountTable, accountTables } from "@backup/account/domain/tables";
import { reviewDedupeKey } from "@brain/application/commands/review-service";

/** The authenticated caller. Every `owner` column must end up as this, whatever the file says. */
const OWNER = "11111111-1111-4111-8111-111111111111";

/** Import time, injected so the clamp is a fact rather than a race. */
const NOW = 1_700_000_000_000;
const EARLIER = 1_600_000_000_000;
const LATER = NOW + 86_400_000;

/** The ceiling `import-brain.ts` keeps on one payload line. */
const MAX_ROW_BYTES = 8 * 1024 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** One payload line, and the INDEX entry that names it. */
interface Row {
  table: string;
  rowId: string;
  values: Record<string, unknown>;
}

/**
 * A row the archive would carry: the id is written into the line, as the exporter writes it.
 *
 * `memory_tag_map` is the one table with no id of its own, so the descriptor decides whether
 * the line carries one — writing an `id` the table does not have would be testing a shape the
 * exporter cannot produce.
 */
function row(table: string, rowId: string, values: Record<string, unknown> = {}): Row {
  const carriesId = accountTable("brain", table, "test").columns.id?.rule === "id";
  return { table, rowId, values: carriesId ? { id: rowId, ...values } : { ...values } };
}

const brain = (id: string, values: Record<string, unknown> = {}): Row =>
  row("brains", id, { name: "Work", status: "active", ...values });

const entity = (id: string, brainId: string, values: Record<string, unknown> = {}): Row =>
  row("brain_entities", id, { brain_id: brainId, name: "Ada", type: "person", ...values });

const memory = (id: string, brainId: string, values: Record<string, unknown> = {}): Row =>
  row("memories", id, { brain_id: brainId, title: "t", content: "c", ...values });

const link = (id: string, brainId: string, values: Record<string, unknown> = {}): Row =>
  row("memory_links", id, { brain_id: brainId, link_type: "relates_to", ...values });

const mention = (id: string, brainId: string, values: Record<string, unknown> = {}): Row =>
  row("memory_mentions", id, { brain_id: brainId, surface: "Ada", ...values });

/** The INDEX and the payload a well-formed archive of these rows would carry. */
function archive(rows: Row[]): { entries: AfrBrainEntry[]; payload: Buffer[] } {
  const entries = rows.map((one, at) => ({
    table: one.table,
    rowId: one.rowId,
    orderKey: at,
  }));
  const lines = rows.map((one) => Buffer.from(`${JSON.stringify(one.values)}\n`, "utf8"));
  return { entries, payload: [Buffer.concat(lines)] };
}

function fakeReader(
  entries: AfrBrainEntry[],
  payload: Buffer[],
  overrides: Partial<AfrSummary> = {}
): AfrReadable {
  const summary: AfrSummary = {
    accountBackupId: "A".repeat(52),
    appVersion: "test",
    counts: {
      folders: 0,
      files: 0,
      memories: entries.filter((entry) => entry.table === "memories").length,
      rows: entries.length,
    },
    schemaVersion: 28,
    sourceInstanceId: "test-instance",
    totalBytes: payload.reduce((sum, piece) => sum + piece.length, 0),
    ...overrides,
  };
  return {
    summary,
    async *indexLines() {
      let lineNumber = 0;
      for (const entry of entries) {
        lineNumber += 1;
        const encoded = encodeBrainEntry(entry).toString("utf8");
        yield {
          text: encoded.slice(0, encoded.length - 1),
          lineNumber,
          where: `index line ${lineNumber}`,
        };
      }
    },
    async *readPayload() {
      for (const piece of payload) yield piece;
    },
  };
}

interface Inserted {
  table: string;
  rows: Record<string, unknown>[];
}

interface Relinked {
  table: string;
  column: string;
  pairs: { id: string; value: string }[];
}

function fakeSink(opts: { hasDefault?: boolean } = {}) {
  const inserts: Inserted[] = [];
  const relinks: Relinked[] = [];
  const sink: BrainImportSink = {
    async hasDefaultBrain() {
      return opts.hasDefault === true;
    },
    async insert(table, rows) {
      inserts.push({ table: table.name, rows: rows.map((one) => ({ ...one })) });
    },
    async relink(table, column, pairs) {
      relinks.push({ table: table.name, column, pairs: pairs.map((one) => ({ ...one })) });
    },
  };
  return { sink, inserts, relinks };
}

interface RunInput {
  entries: AfrBrainEntry[];
  payload: Buffer[];
  mode?: RestoreMode;
  summary?: Partial<AfrSummary>;
  hasDefault?: boolean;
  budget?: ImportBudget;
  now?: number;
}

async function run(input: RunInput) {
  const reader = fakeReader(input.entries, input.payload, input.summary);
  const { sink, inserts, relinks } = fakeSink({ hasDefault: input.hasDefault });
  const report = await importBrain({
    reader,
    sink,
    mode: input.mode ?? "merge",
    budget: input.budget ?? declaredBudget(reader.summary.totalBytes),
    ownerUserId: OWNER,
    now: input.now ?? NOW,
  });
  return { report, inserts, relinks };
}

/** Every row that landed, in the order the sink saw it. */
const landed = (inserts: Inserted[]): Record<string, unknown>[] =>
  inserts.flatMap((one) => one.rows);

/** The rows of one table, which is where nearly every assertion here starts. */
const of = (inserts: Inserted[], table: string): Record<string, unknown>[] =>
  inserts.filter((one) => one.table === table).flatMap((one) => one.rows);

/**
 * The refusal a call raised, typed.
 *
 * Every refusal in this format shares one fixed generic `message` by design (§12) — the
 * specific half is `detail` — so an error has to be caught to be read.
 */
async function caught<E extends Error>(
  ctor: new (...args: never[]) => E,
  fn: () => Promise<unknown>
): Promise<E> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ctor) return error;
    throw error;
  }
  throw new Error(`expected ${ctor.name}, nothing was thrown`);
}

/* ── the INDEX: the directory the payload is held to ──────────────────────── */

describe("importBrain: the INDEX", () => {
  it("refuses a table a brain backup does not carry", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "users", rowId: "u1", orderKey: 0 }],
        payload: [Buffer.from('{"id":"u1"}\n', "utf8")],
        summary: { counts: { folders: 0, files: 0, memories: 0, rows: 1 } },
      })
    );
    expect(error.detail).toBe("index line 1.table users is not carried by a brain backup");
  });

  it("refuses a table name the format cannot even spell", async () => {
    // `decodeBrainEntry` holds the shape, so a name like this never reaches the membership
    // check — which is why the membership refusal above can afford to quote the name back.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "Memories", rowId: "x1", orderKey: 0 }],
        payload: [Buffer.from('{"id":"x1"}\n', "utf8")],
        summary: { counts: { folders: 0, files: 0, memories: 0, rows: 1 } },
      })
    );
    expect(error.detail).toBe("index line 1.table is not a well-formed value");
  });

  it("refuses an index that lists a table before one it depends on", async () => {
    // Rank order is what makes the single forward pass legal: a memory's brain must already
    // be inserted. An index that lists them the other way round is refused before a single
    // payload byte is read.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [
          { table: "memories", rowId: "m1", orderKey: 0 },
          { table: "brains", rowId: "b1", orderKey: 1 },
        ],
        payload: [],
      })
    );
    expect(error.detail).toBe("index line 2 lists brains after a table that follows it");
  });

  it("refuses two rows that claim one position", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [
          { table: "brains", rowId: "b1", orderKey: 0 },
          { table: "brains", rowId: "b2", orderKey: 0 },
        ],
        payload: [],
      })
    );
    expect(error.detail).toBe("index line 2 is out of order");
  });

  it("refuses an index that disagrees with the summary about how many rows there are", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        ...archive([brain("b1")]),
        summary: { counts: { folders: 0, files: 0, memories: 0, rows: 2 } },
      })
    );
    expect(error.detail).toBe("index lists 1 rows, summary declared 2");
  });

  it("refuses an index that disagrees with the summary about how many memories", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        ...archive([brain("b1"), memory("m1", "b1")]),
        summary: { counts: { folders: 0, files: 0, memories: 2, rows: 2 } },
      })
    );
    expect(error.detail).toBe("index lists 1 memories, summary declared 2");
  });

  it("refuses a row count past the cap before it reads anything at all", async () => {
    const error = await caught(AfrTooLargeError, () =>
      run({
        entries: [],
        payload: [],
        summary: { counts: { folders: 0, files: 0, memories: 0, rows: 500_001 } },
      })
    );
    expect(error.rows).toBe(500_001);
    expect(error.cap).toBe(500_000);
    expect(error.detail).toBe("claims 500001 rows, cap 500000");
  });
});

/* ── the payload: NDJSON, one line per index entry ─────────────────────────── */

describe("importBrain: the payload", () => {
  it("pairs each line with the index entry at the same position", async () => {
    const { report, inserts } = await run(archive([brain("b1"), memory("m1", "b1")]));
    expect(inserts.map((one) => one.table)).toEqual(["brains", "memories"]);
    expect(report.rows).toBe(2);
  });

  it("refuses a line the index never promised", async () => {
    const one = archive([brain("b1")]);
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: one.entries,
        payload: [Buffer.concat([...one.payload, Buffer.from('{"id":"b2"}\n', "utf8")])],
      })
    );
    expect(error.detail).toBe("the payload carries a row past the last index line");
  });

  it("refuses a payload that stops short of the index", async () => {
    const one = archive([brain("b1"), brain("b2")]);
    const error = await caught(AfrCorruptError, () =>
      run({ entries: one.entries, payload: [Buffer.from('{"id":"b1"}\n', "utf8")] })
    );
    expect(error.detail).toBe("the payload ended after 1 rows, the index lists 2");
  });

  it("refuses a last line with no terminator, which is what a truncated download looks like", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.from('{"id":"b1"}', "utf8")],
      })
    );
    expect(error.detail).toBe("the payload's last row is not terminated");
  });

  it("refuses a line that is not JSON", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.from("not json at all\n", "utf8")],
      })
    );
    expect(error.detail).toBe("payload row 1 is not JSON");
  });

  it("refuses a line that parses but is not an object", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.from('["b1"]\n', "utf8")],
      })
    );
    expect(error.detail).toBe("payload row 1 is not an object");
  });

  it("rejoins a row split across chunk boundaries", async () => {
    // The transport decides where a chunk ends, so a row is routinely cut in two — and the
    // partial tail is copied rather than kept as a view onto a 4 MiB chunk.
    const one = archive([brain("b1")]);
    const whole = one.payload[0];
    const pieces = [
      whole.subarray(0, 3),
      whole.subarray(3, 4),
      whole.subarray(4, whole.length - 1),
      whole.subarray(whole.length - 1),
    ];
    const { inserts, report } = await run({ entries: one.entries, payload: pieces });
    expect(report.rows).toBe(1);
    expect(of(inserts, "brains")[0].name).toBe("Work");
  });

  it("refuses a completed line longer than the row ceiling", async () => {
    // A line has to be whole before it can be parsed, so without this ceiling one 40 GB line
    // is a memory-exhaustion attack that the byte budget alone would not catch.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.concat([Buffer.alloc(MAX_ROW_BYTES + 1, 0x20), Buffer.from("\n")])],
      })
    );
    expect(error.detail).toBe(`a payload row is longer than ${MAX_ROW_BYTES} bytes`);
  });

  it("refuses a line that passes the ceiling while it is still accumulating", async () => {
    // The same ceiling on the held remainder, so a payload that simply never sends a newline
    // is stopped at eight megabytes instead of at the end of the stream.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.alloc(MAX_ROW_BYTES + 1, 0x20)],
      })
    );
    expect(error.detail).toBe(`a payload row is longer than ${MAX_ROW_BYTES} bytes`);
  });

  it("refuses a payload that delivers more bytes than the summary declared", async () => {
    // §11: the size an archive announces is not trusted, and the check is a running one —
    // a header claiming four bytes in front of a 40 GB payload is stopped as it arrives.
    const one = archive([brain("b1")]);
    const size = one.payload[0].length;
    const error = await caught(AfrCorruptError, () =>
      run({ ...one, budget: declaredBudget(4) })
    );
    expect(error.detail).toBe(`payload has delivered ${size} bytes, past the declared 4`);
  });

  it("reports the bytes it was charged for", async () => {
    const one = archive([brain("b1"), memory("m1", "b1")]);
    const { report } = await run(one);
    expect(report.bytes).toBe(one.payload[0].length);
  });
});

/* ── ids: every primary key is reissued here ───────────────────────────────── */

describe("importBrain: ids", () => {
  it("mints a fresh uuid for every row and never keeps the archive's", async () => {
    const { inserts } = await run(archive([brain("b1"), memory("m1", "b1")]));
    const ids = landed(inserts).map((one) => one.id);
    expect(ids.every((id) => typeof id === "string" && UUID_RE.test(id))).toBe(true);
    expect(ids).not.toContain("b1");
    expect(ids).not.toContain("m1");
    expect(new Set(ids).size).toBe(2);
  });

  it("refuses a line whose id is not the one the index gave that row", async () => {
    // The INDEX is the directory every reference resolves through, so a payload naming a
    // different id would put the mapping and the data out of step.
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "brains", rowId: "b1", orderKey: 0 }],
        payload: [Buffer.from('{"id":"b2","name":"Work"}\n', "utf8")],
      })
    );
    expect(error.detail).toBe("payload row 1.id is not the id the index gave this row");
  });

  it("refuses one table naming two rows the same", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([brain("b1"), brain("b1")]))
    );
    expect(error.detail).toBe("payload row 2 reuses an id brains has already used");
  });

  it("lets two different tables use the same label", async () => {
    const { inserts } = await run(archive([brain("x"), memory("x", "x")]));
    const brainId = of(inserts, "brains")[0].id;
    const memoryRow = of(inserts, "memories")[0];
    expect(memoryRow.id).not.toBe(brainId);
    expect(memoryRow.brain_id).toBe(brainId);
  });

  it("inserts the one table with no id of its own as just its two references", async () => {
    const { inserts } = await run(
      archive([
        brain("b1"),
        memory("m1", "b1"),
        row("memory_tags", "t1", { brain_id: "b1", name: "work" }),
        row("memory_tag_map", "3", { memory_id: "m1", tag_id: "t1" }),
      ])
    );
    const mapped = of(inserts, "memory_tag_map")[0];
    expect(Object.keys(mapped).sort()).toEqual(["memory_id", "tag_id"]);
    expect(mapped.memory_id).toBe(of(inserts, "memories")[0].id);
    expect(mapped.tag_id).toBe(of(inserts, "memory_tags")[0].id);
  });
});

/* ── the owner: scope comes from the caller, never from the file ───────────── */

describe("importBrain: the owner", () => {
  it("overwrites an owner column even when the archive names somebody else", async () => {
    const { inserts } = await run(
      archive([brain("b1", { owner_user_id: "99999999-9999-4999-8999-999999999999" })])
    );
    expect(of(inserts, "brains")[0].owner_user_id).toBe(OWNER);
  });

  it("fills a nullable owner column too", async () => {
    // `memories.created_by` and `memory_versions.changed_by` are nullable, and both still
    // become the caller: a restored row attributed to a stranger is the thing §10 forbids.
    const { inserts } = await run(
      archive([
        brain("b1"),
        memory("m1", "b1", { created_by: "99999999-9999-4999-8999-999999999999" }),
        row("memory_versions", "v1", { memory_id: "m1", version_number: 1, title: "t" }),
      ])
    );
    expect(of(inserts, "memories")[0].created_by).toBe(OWNER);
    expect(of(inserts, "memory_versions")[0].changed_by).toBe(OWNER);
  });
});

/* ── references: resolved only through ids this import minted ──────────────── */

describe("importBrain: references", () => {
  it("resolves a reference to the id this import minted for its target", async () => {
    const { inserts } = await run(
      archive([
        brain("b1"),
        row("brain_projects", "p1", { brain_id: "b1", name: "Proj" }),
        memory("m1", "b1", { project_id: "p1" }),
      ])
    );
    expect(of(inserts, "memories")[0].project_id).toBe(of(inserts, "brain_projects")[0].id);
  });

  it("refuses a required reference to a row the archive does not carry", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([brain("b1"), memory("m1", "nope")]))
    );
    expect(error.detail).toBe("payload row 2.brain_id names a brains this archive does not carry");
  });

  it("refuses a required reference that names nothing at all", async () => {
    const error = await caught(AfrCorruptError, () =>
      run({
        entries: [{ table: "memories", rowId: "m1", orderKey: 0 }],
        payload: [Buffer.from('{"id":"m1","title":"t","content":"c"}\n', "utf8")],
      })
    );
    expect(error.detail).toBe("payload row 1.brain_id names no brains, and every row must");
  });

  it("nulls an optional reference whose target did not travel", async () => {
    // Losing "this memory was filed under a project" is a fact a restore may lose; losing
    // the memory is not.
    const { inserts } = await run(archive([brain("b1"), memory("m1", "b1", { project_id: "p9" })]));
    expect(of(inserts, "memories")[0].project_id).toBeNull();
  });

  it("refuses a label the exporter could not have written", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([brain("b1"), memory("m1", "has space")]))
    );
    expect(error.detail).toBe("payload row 2.brain_id is not a row id");
  });

  it("defers a self-reference and fills it once every row of the table exists", async () => {
    // A memory may be superseded by one listed three thousand lines later, so the column goes
    // in NULL and the second pass fills it.
    const { inserts, relinks } = await run(
      archive([brain("b1"), memory("m1", "b1", { superseded_by_id: "m2" }), memory("m2", "b1")])
    );
    const [first, second] = of(inserts, "memories");
    expect(first.superseded_by_id).toBeNull();
    expect(relinks).toEqual([
      {
        table: "memories",
        column: "superseded_by_id",
        pairs: [{ id: first.id, value: second.id }],
      },
    ]);
  });

  it("leaves a self-reference alone when its target did not travel", async () => {
    const { inserts, relinks } = await run(
      archive([brain("b1"), memory("m1", "b1", { superseded_by_id: "gone" })])
    );
    expect(of(inserts, "memories")[0].superseded_by_id).toBeNull();
    expect(relinks).toEqual([]);
  });

  it("does not touch the sink's second pass when nothing was deferred", async () => {
    const { relinks } = await run(archive([brain("b1"), memory("m1", "b1")]));
    expect(relinks).toEqual([]);
  });

  it("batches the second pass the same way it batches inserts", async () => {
    const rows: Row[] = [brain("b1")];
    for (let at = 0; at <= 500; at += 1) {
      rows.push(memory(`m${at}`, "b1", { superseded_by_id: "m501" }));
    }
    rows.push(memory("m501", "b1"));
    const { relinks } = await run(archive(rows));
    expect(relinks.map((one) => one.pairs.length)).toEqual([500, 1]);
    expect(relinks.every((one) => one.column === "superseded_by_id")).toBe(true);
  });
});

/* ── timestamps: provenance, clamped ───────────────────────────────────────── */

describe("importBrain: timestamps", () => {
  it("keeps a past timestamp exactly as the archive wrote it", async () => {
    const { inserts } = await run(archive([brain("b1", { created_at: EARLIER })]));
    expect(of(inserts, "brains")[0].created_at).toEqual(new Date(EARLIER));
  });

  it("clamps a timestamp from the future to import time", async () => {
    // A row claiming to have been written next year sorts above everything real, in every
    // list, forever.
    const { inserts } = await run(archive([brain("b1", { created_at: LATER })]));
    expect(of(inserts, "brains")[0].created_at).toEqual(new Date(NOW));
  });

  it("leaves a validity window in the future alone", async () => {
    const { inserts } = await run(
      archive([brain("b1"), memory("m1", "b1", { valid_until: LATER })])
    );
    expect(of(inserts, "memories")[0].valid_until).toEqual(new Date(LATER));
  });

  it("omits a timestamp the archive did not carry, so the column default applies", async () => {
    const { inserts } = await run(archive([brain("b1", { created_at: null })]));
    expect("created_at" in of(inserts, "brains")[0]).toBe(false);
  });

  it("refuses a timestamp outside the range the format can spell", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([brain("b1", { created_at: 0 })]))
    );
    expect(error.detail).toBe("payload row 1.created_at is 0, outside [1, 253402300799000]");
  });

  it("refuses a timestamp that is not a number", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(archive([brain("b1", { created_at: "yesterday" })]))
    );
    expect(error.detail).toBe("payload row 1.created_at is not an integer");
  });
});

/* ── the columns the destination decides ───────────────────────────────────── */

describe("importBrain: server columns", () => {
  it("makes the first brain of an account without one the default", async () => {
    const { inserts } = await run({ ...archive([brain("b1"), brain("b2")]), hasDefault: false });
    expect(of(inserts, "brains").map((one) => one.is_default)).toEqual([true, false]);
  });

  it("never takes the default away from a brain the account already has", async () => {
    // `brains_owner_default_unique` is the one constraint scoped by a column the restore does
    // not reissue, and losing the flag is a preference, not data.
    const { inserts } = await run({ ...archive([brain("b1"), brain("b2")]), hasDefault: true });
    expect(of(inserts, "brains").map((one) => one.is_default)).toEqual([false, false]);
  });

  it("never restores a memory into the recycle bin", async () => {
    const { inserts } = await run(
      archive([brain("b1"), memory("m1", "b1", { deleted_at: EARLIER })])
    );
    expect("deleted_at" in of(inserts, "memories")[0]).toBe(false);
  });

  it("leaves a generated or derived column out of the insert entirely", async () => {
    // Naming a generated column in an INSERT is an error in Postgres, so this is not merely
    // a value we ignore.
    const { inserts } = await run(
      archive([
        brain("b1"),
        memory("m1", "b1", {
          embedding: [0.1, 0.2],
          embedding_model: "text-embedding-3-small",
          search_vector: "work ada",
        }),
      ])
    );
    const landedMemory = of(inserts, "memories")[0];
    expect("embedding" in landedMemory).toBe(false);
    expect("embedding_model" in landedMemory).toBe(false);
    expect("search_vector" in landedMemory).toBe(false);
  });

  it("rebuilds a review finding's identity from the ids this restore issued", async () => {
    // The archive's own `dedupe_key` names rows that no longer exist, and a stale one would
    // let the next health scan file the same finding a second time.
    const { inserts } = await run(
      archive([
        brain("b1"),
        memory("m1", "b1"),
        memory("m2", "b1"),
        row("brain_review_items", "r1", {
          brain_id: "b1",
          kind: "duplicate",
          status: "open",
          memory_id: "m1",
          related_memory_id: "m2",
          dedupe_key: "duplicate:m1:m2",
        }),
      ])
    );
    const [first, second] = of(inserts, "memories").map((one) => String(one.id));
    expect(of(inserts, "brain_review_items")[0].dedupe_key).toBe(
      reviewDedupeKey("duplicate", [first, second])
    );
  });

  it("refuses an archive that files one review finding twice", async () => {
    const finding = (id: string): Row =>
      row("brain_review_items", id, {
        brain_id: "b1",
        kind: "duplicate",
        status: "open",
        memory_id: "m1",
        related_memory_id: "m2",
      });
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([brain("b1"), memory("m1", "b1"), memory("m2", "b1"), finding("r1"), finding("r2")])
      )
    );
    expect(error.detail).toBe(
      "payload row 5 repeats a review finding this archive has already filed"
    );
  });
});

/* ── the CHECK constraints, refused here rather than by Postgres ───────────── */

/** A brain, an entity and two memories: everything a link or a mention needs to exist. */
const linkable = (): Row[] => [brain("b1"), entity("e1", "b1"), memory("m1", "b1"), memory("m2", "b1")];

describe("importBrain: the CHECK constraints", () => {
  it("accepts a well-formed link to an entity", async () => {
    const { inserts } = await run(
      archive([
        ...linkable(),
        link("l1", "b1", {
          source_memory_id: "m1",
          target_type: "entity",
          target_entity_id: "e1",
        }),
      ])
    );
    const landedLink = of(inserts, "memory_links")[0];
    expect(landedLink.target_entity_id).toBe(of(inserts, "brain_entities")[0].id);
    expect(landedLink.target_memory_id).toBeNull();
  });

  it("refuses a link that names two targets", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          link("l1", "b1", {
            source_memory_id: "m1",
            target_type: "memory",
            target_memory_id: "m2",
            target_entity_id: "e1",
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_links_one_target");
  });

  it("refuses a link that names no target", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          link("l1", "b1", { source_memory_id: "m1", target_type: "memory" }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_links_one_target");
  });

  it("refuses a link whose target_type does not match the target it carries", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          link("l1", "b1", {
            source_memory_id: "m1",
            target_type: "entity",
            target_memory_id: "m2",
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_links_target_type_matches");
  });

  it("refuses a link from a memory to itself", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          link("l1", "b1", {
            source_memory_id: "m1",
            target_type: "memory",
            target_memory_id: "m1",
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_links_no_self_link");
  });

  it("accepts a well-formed mention", async () => {
    const { inserts } = await run(
      archive([
        ...linkable(),
        mention("x1", "b1", {
          memory_id: "m1",
          entity_id: "e1",
          field: "content",
          start_offset: 0,
          end_offset: 3,
        }),
      ])
    );
    expect(of(inserts, "memory_mentions")[0].surface).toBe("Ada");
  });

  it("refuses a mention whose offsets do not advance", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          mention("x1", "b1", {
            memory_id: "m1",
            entity_id: "e1",
            field: "content",
            start_offset: 5,
            end_offset: 5,
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_mentions_offsets");
  });

  it("refuses an offset that is not a number, rather than letting Postgres answer 22P02", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          mention("x1", "b1", {
            memory_id: "m1",
            entity_id: "e1",
            field: "content",
            start_offset: "0",
            end_offset: 3,
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_mentions_offsets");
  });

  it("refuses a mention of a field the schema does not have", async () => {
    const error = await caught(AfrCorruptError, () =>
      run(
        archive([
          ...linkable(),
          mention("x1", "b1", {
            memory_id: "m1",
            entity_id: "e1",
            field: "body",
            start_offset: 0,
            end_offset: 3,
          }),
        ])
      )
    );
    expect(error.detail).toBe("payload row 5 breaks memory_mentions_field");
  });
});

/* ── drift: the two things this feature reimplements on purpose ────────────── */

describe("importBrain: drift against the rest of the app", () => {
  it("implements exactly the checks the brain descriptors declare", async () => {
    // A CHECK added to the schema and only half-taught to the backup is discovered here
    // rather than as an archive that refuses itself on the way back in.
    const declared = accountTables("brain")
      .flatMap((table) => table.checks ?? [])
      .sort();
    expect(declared.length).toBeGreaterThan(0);
    expect(Object.keys(ACCOUNT_ROW_CHECKS).sort()).toEqual(declared);
    for (const name of declared) {
      expect(typeof ACCOUNT_ROW_CHECKS[name]).toBe("function");
    }
  });

  it("spells a review finding's key the same way the brain feature does", async () => {
    // The feature boundary forbids importing `reviewDedupeKey` from the importer, so the two
    // spellings are held equal here instead — including the ordering, which both sort.
    const { inserts } = await run(
      archive([
        brain("b1"),
        memory("m1", "b1"),
        memory("m2", "b1"),
        row("brain_review_items", "r1", {
          brain_id: "b1",
          kind: "contradiction",
          status: "open",
          memory_id: "m2",
          related_memory_id: "m1",
        }),
      ])
    );
    const [first, second] = of(inserts, "memories").map((one) => String(one.id));
    expect(of(inserts, "brain_review_items")[0].dedupe_key).toBe(
      reviewDedupeKey("contradiction", [second, first])
    );
  });
});

/* ── batching and the report ───────────────────────────────────────────────── */

describe("importBrain: batching", () => {
  it("never lets one insert straddle two tables", async () => {
    const { inserts } = await run(
      archive([brain("b1"), memory("m1", "b1"), memory("m2", "b1")])
    );
    expect(inserts.map((one) => [one.table, one.rows.length])).toEqual([
      ["brains", 1],
      ["memories", 2],
    ]);
  });

  it("cuts a long table into batches of five hundred", async () => {
    const rows: Row[] = [brain("b1")];
    for (let at = 0; at < 501; at += 1) rows.push(memory(`m${at}`, "b1"));
    const { inserts, report } = await run(archive(rows));
    expect(inserts.map((one) => [one.table, one.rows.length])).toEqual([
      ["brains", 1],
      ["memories", 500],
      ["memories", 1],
    ]);
    expect(report.rows).toBe(502);
  });
});

describe("importBrain: the report", () => {
  it("reports what landed, in the vocabulary the audit row uses", async () => {
    const one = archive([brain("b1"), memory("m1", "b1")]);
    const { report } = await run(one);
    expect(report).toEqual({
      domain: "brain",
      mode: "merge",
      rows: 2,
      bytes: one.payload[0].length,
      skipped: 0,
      renamed: 0,
    });
  });

  it("writes the same rows for replace and only carries the mode through", async () => {
    // `mode` changes nothing here: every unique in this domain is scoped by a column the
    // restore reissues, so there is no conflict to resolve. The difference is at commit.
    const one = archive([brain("b1"), memory("m1", "b1")]);
    const merged = await run({ ...one, mode: "merge" });
    const replaced = await run({ ...one, mode: "replace" });
    expect(replaced.report.mode).toBe("replace");
    expect(replaced.inserts.map((at) => [at.table, at.rows.length])).toEqual(
      merged.inserts.map((at) => [at.table, at.rows.length])
    );
    expect(replaced.report.rows).toBe(merged.report.rows);
  });
});

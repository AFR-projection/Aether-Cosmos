/**
 * The brain export: sixteen tables' worth of rows, in an order a restore can replay.
 *
 * The traversal is written once and run twice — `walkBrain` below — and that is the load
 * bearing decision in this file. Both passes have to make byte-identical choices: the same
 * rows, in the same order, with the same columns, or the INDEX describes a payload that
 * does not exist. Writing the projection out twice, once for measuring and once for
 * streaming, would be two chances to make different choices. So there is one generator and
 * two consumers, and the streaming consumer additionally compares the line it just derived
 * against the line the INDEX already committed to — a divergence aborts the stream, which
 * truncates the download, which the importer refuses (#7). An archive that is quietly
 * wrong is not a possible outcome.
 *
 * What travels and what does not is not decided here. `tables.ts` holds that, column by
 * column, with a reason for every omission; this file only obeys it.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §11.
 */

import { AFR_MAX_INDEX_BYTES } from "@backup/account/domain/archive";
import { AccountBackupChangedError, AccountBackupTooBigError } from "@backup/account/domain/errors";
import {
  BRAIN_ROW_ID_RE,
  INDEX_LINE_TERMINATOR,
  encodeBrainEntry,
} from "@backup/account/domain/index-entries";
import { rowJsonBytes, type RowValue } from "@backup/account/domain/row-json";
import { rowCheckFailure } from "@backup/account/domain/row-checks";
import { AFR_BRAIN_ROW_CAP } from "@backup/account/domain/summary";
import { accountTables, refsOf, type AccountTable } from "@backup/account/domain/tables";
import type {
  AccountExportPlan,
  BrainExportSource,
} from "@backup/account/application/export-types";

/**
 * Roughly the year 9999 — the bound the format's timestamp fields already enforce, and
 * enforced here as the same *inclusive* bound the SUMMARY decoder uses. A millisecond this
 * file emits and the domain refuses would be an archive we write and cannot read back.
 */
const MAX_TIMESTAMP = 253_402_300_799_000;

const TERMINATOR = Buffer.from(INDEX_LINE_TERMINATOR, "utf8");

/** One row, as both passes see it. */
interface EmittedRow {
  table: string;
  /** The INDEX line, terminator included. */
  indexLine: Buffer;
  /** The payload line, terminator included. */
  payloadLine: Buffer;
}

/**
 * What the walk counts on its way through, filled in as it goes.
 *
 * A mutable argument rather than a return value because the walk is a generator: a
 * consumer that stops early — the payload pass raising `AccountBackupChangedError` on the
 * first bad line — would never see a returned value, and the numbers are only meaningful
 * for a walk that ran to the end anyway.
 */
interface WalkTotals {
  rows: number;
  memories: number;
  payloadBytes: number;
  oldest: number;
  newest: number;
}

function newTotals(): WalkTotals {
  return { rows: 0, memories: 0, payloadBytes: 0, oldest: Number.MAX_SAFE_INTEGER, newest: 0 };
}

/**
 * A timestamp the way a payload line carries it: epoch milliseconds, or absent.
 *
 * Absent rather than null, because a `NOT NULL` column with no usable value is better
 * served by the database's own `DEFAULT now()` than by an importer inserting a NULL the
 * constraint would reject. A value outside the representable range is treated the same
 * way — it is a clock artefact, not information worth carrying.
 */
function toEpochMs(value: unknown): number | undefined {
  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : typeof value === "string"
          ? Date.parse(value)
          : NaN;
  return Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMESTAMP ? ms : undefined;
}

/** A reference, as the archive spells one: an opaque label the importer remaps. */
function toRefLabel(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** What one projected row contributes, before it is turned into bytes. */
interface ProjectedRow {
  ownId: string | null;
  values: Record<string, RowValue | undefined>;
  oldest: number;
  newest: number;
}

/**
 * One row projected onto the columns the descriptor says travel, or `null` if the row
 * cannot travel at all.
 *
 * The `null` case is referential closure, on the export side: a row whose non-nullable
 * reference points at something this archive does not carry would arrive at an importer
 * with nothing to resolve it against. It is dropped — and because tables are walked in
 * rank order the drop cascades correctly, a memory left behind taking its versions and its
 * links with it, each one discovering in turn that its own target is missing.
 *
 * The exception is a reference into the row's own table, which for this domain means
 * exactly `memories.superseded_by_id`. A forward reference cannot be checked while
 * streaming — the target may be three thousand rows further on — so the label is carried
 * verbatim and the importer's second pass resolves it or nulls it. That is safe for the
 * same reason the check is sufficient elsewhere: every other reference points at a lower
 * rank, which is already fully emitted by the time it is read.
 *
 * The second `null` case is a row that fails one of its table's CHECK constraints once the
 * references are resolved — see the end of the function.
 */
function projectRow(
  table: AccountTable,
  raw: Record<string, unknown>,
  emitted: ReadonlyMap<string, ReadonlySet<string>>
): ProjectedRow | null {
  const values: Record<string, RowValue | undefined> = {};
  let ownId: string | null = null;
  let oldest = Number.MAX_SAFE_INTEGER;
  let newest = 0;

  for (const [column, rule] of Object.entries(table.columns)) {
    switch (rule.rule) {
      case "drop":
      case "server":
      case "owner":
        // Rebuilt, reissued, or taken from the authenticated caller. Never from here.
        continue;

      case "id": {
        const id = toRefLabel(raw[column]);
        if (id === null || !BRAIN_ROW_ID_RE.test(id)) {
          // The archive names every brain row, and a row it cannot name is a row the
          // payload and the INDEX would disagree about. Our own tables cannot produce
          // this — they are uuids — so it is a bug here, not a refusal for the user.
          throw new Error(`${table.name}.${column} is not a usable row id`);
        }
        values[column] = id;
        ownId = id;
        continue;
      }

      case "ref": {
        const label = toRefLabel(raw[column]);
        if (label === null) {
          if (rule.nullable !== true) return null;
          values[column] = null;
          continue;
        }
        if (rule.table === table.name) {
          values[column] = label;
          continue;
        }
        if (emitted.get(rule.table)?.has(label) === true) {
          values[column] = label;
          continue;
        }
        if (rule.nullable !== true) return null;
        values[column] = null;
        continue;
      }

      case "time": {
        const ms = toEpochMs(raw[column]);
        values[column] = ms;
        if (ms !== undefined) {
          oldest = Math.min(oldest, ms);
          newest = Math.max(newest, ms);
        }
        continue;
      }

      default: {
        // `carry`, `path`, `payload`. Whatever the column holds, handed to the payload
        // serializer, which is the one place that decides what JSON can express. A value
        // of `undefined` — a column the source did not select — is dropped rather than
        // written as null, so the importer can tell "not carried" from "SQL NULL".
        values[column] = raw[column] as RowValue | undefined;
        continue;
      }
    }
  }

  // The row against its own table's CHECK constraints, with every reference already resolved
  // to a label or to null. A row that fails one cannot be inserted anywhere — the commonest
  // case being a link whose nullable target was just nulled by the closure above, beside a
  // `target_type` that still names it — so it does not travel. Carrying it would produce an
  // archive that refuses itself on the way back in, which is the one outcome a backup may
  // never have. See `domain/row-checks.ts`.
  if (rowCheckFailure(table, values) !== null) return null;

  return { ownId, values, oldest, newest };
}

/**
 * The single traversal: rank order, one yield per emitted row.
 *
 * `refTargets` is why the id sets do not cost what they look like they cost. Only a table
 * some other table points at needs its ids remembered, which excludes the largest ones —
 * versions, mentions, links, the tag map — and leaves the handful actually referenced.
 */
async function* walkBrain(
  source: BrainExportSource,
  totals: WalkTotals
): AsyncGenerator<EmittedRow, void, void> {
  const tables = accountTables("brain");
  const refTargets = new Set<string>();
  for (const table of tables) {
    for (const ref of refsOf(table)) {
      if (ref.table !== table.name) refTargets.add(ref.table);
    }
  }

  const emitted = new Map<string, Set<string>>();
  for (const name of refTargets) emitted.set(name, new Set<string>());

  // Archive-wide and ascending, which is what `AccountTable.rank` promises the importer:
  // walk the tables in rank order, stamp a running counter, and `orderKey` ascending is
  // the same statement as "every reference was already inserted".
  let orderKey = 0;

  for (const table of tables) {
    for await (const raw of source.rows(table)) {
      const projected = projectRow(table, raw, emitted);
      if (projected === null) continue;

      // A table with no id of its own — `memory_tag_map`, two references and nothing
      // else — is named by its position. Nothing references it, so no other row can ever
      // need to resolve that label.
      const rowId = projected.ownId ?? String(orderKey);
      const payloadLine = Buffer.concat([rowJsonBytes(projected.values), TERMINATOR]);

      totals.rows += 1;
      if (totals.rows > AFR_BRAIN_ROW_CAP) {
        throw new AccountBackupTooBigError(`more than ${AFR_BRAIN_ROW_CAP} brain rows`);
      }
      if (table.name === "memories") totals.memories += 1;
      totals.payloadBytes += payloadLine.length;
      totals.oldest = Math.min(totals.oldest, projected.oldest);
      totals.newest = Math.max(totals.newest, projected.newest);

      yield {
        table: table.name,
        indexLine: encodeBrainEntry({ table: table.name, rowId, orderKey }),
        payloadLine,
      };

      if (projected.ownId !== null) emitted.get(table.name)?.add(projected.ownId);
      orderKey += 1;
    }
  }
}

export async function planBrainExport(source: BrainExportSource): Promise<AccountExportPlan> {
  const totals = newTotals();
  const lines: Buffer[] = [];
  let indexBytes = 0;

  for await (const row of walkBrain(source, totals)) {
    indexBytes += row.indexLine.length;
    if (indexBytes > AFR_MAX_INDEX_BYTES) {
      // Before a single payload byte: an account this shape cannot produce a readable
      // archive, so the hour spent streaming one would be wasted either way.
      throw new AccountBackupTooBigError(
        `index exceeds ${AFR_MAX_INDEX_BYTES} bytes at ${lines.length} rows`
      );
    }
    lines.push(row.indexLine);
  }

  const index = Buffer.concat(lines);

  return {
    domain: "brain",
    index,
    counts: {
      folders: 0,
      files: 0,
      memories: totals.memories,
      rows: totals.rows,
    },
    dateRange: totals.newest > 0 ? { from: totals.oldest, to: totals.newest } : undefined,
    totalBytes: totals.payloadBytes,
    payload: () => streamBrainPayload(source, index),
  };
}

/**
 * The second pass, checked line by line against the first.
 *
 * The comparison is the whole safety argument for reading the account twice. Every row is
 * re-projected, and the INDEX line that projection produces has to be the line already
 * sitting at this offset of the table of contents the archive has committed to. A row
 * deleted between the passes, or a query that came back in a different order, fails the
 * very next comparison; a walk that ends early fails the length check afterwards.
 */
async function* streamBrainPayload(
  source: BrainExportSource,
  index: Buffer
): AsyncGenerator<Uint8Array, void, void> {
  const totals = newTotals();
  let offset = 0;

  for await (const row of walkBrain(source, totals)) {
    const line = row.indexLine;
    const end = offset + line.length;
    if (end > index.length || index.compare(line, 0, line.length, offset, end) !== 0) {
      throw new AccountBackupChangedError(
        `${row.table} diverged from the index at byte ${offset}`
      );
    }
    offset = end;
    yield row.payloadLine;
  }

  if (offset !== index.length) {
    throw new AccountBackupChangedError(
      `index holds ${index.length} bytes, the payload pass produced ${offset}`
    );
  }
}

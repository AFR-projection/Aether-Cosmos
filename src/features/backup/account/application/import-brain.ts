/**
 * The brain import: thirteen tables of NDJSON turned back into rows nobody else can reach.
 *
 * The whole file rests on one property the descriptor proves rather than assumes — every
 * `ref` points at a table of strictly lower rank (`assertInsertOrder`) — and one the exporter
 * encoded — `orderKey` ascending is rank order. Together they mean the archive can be
 * replayed in a single forward pass: by the time a row that references a memory arrives, the
 * memory has an id, because it was inserted from an earlier line. No dependency graph is
 * resolved at read time, and nothing has to be sorted.
 *
 * Two passes are still needed, and only two:
 *
 *   - **The INDEX first**, because that is the reader's contract and because the INDEX is
 *     what the payload is checked against. It is buffered — one interned table name and one
 *     row id per row — which is the cost of the format putting its table of contents in
 *     front of its data.
 *   - **`memories.superseded_by_id` last**, because a memory may be superseded by one listed
 *     three thousand lines later. Every memory is inserted with the column NULL and
 *     `relink()` fills in the ones whose target turned out to exist.
 *
 * What this file never does is trust an id. Every primary key is reissued here, every
 * reference is resolved through the mapping *this* import built, and every `owner` column is
 * overwritten with the authenticated caller. An archive therefore cannot name a row it does
 * not itself carry — which is what stops one written by somebody else from attaching itself
 * to this account's data (§10, §11).
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §11.
 */

import { randomUUID } from "crypto";

import { AfrCorruptError } from "@backup/account/domain/errors";
import { asRecord, fail, intField } from "@backup/account/domain/fields";
import { BRAIN_ROW_ID_RE, decodeBrainEntry } from "@backup/account/domain/index-entries";
import { rowCheckFailure } from "@backup/account/domain/row-checks";
import { assertWithinRowCaps } from "@backup/account/domain/summary";
import { accountTable, type AccountTable } from "@backup/account/domain/tables";
import type {
  AfrReadable,
  BrainImportSink,
  ImportBudget,
  ImportReport,
  RestoreMode,
} from "@backup/account/application/import-types";

/** Roughly the year 9999 — the same bound the format's own timestamp fields enforce. */
const MAX_TIMESTAMP = 253_402_300_799_000;

/**
 * The most one payload line may be.
 *
 * A line has to be buffered whole before it can be parsed, so without a ceiling a single
 * 40 GB line is a memory-exhaustion attack that the byte budget alone would not stop — an
 * account with half a million rows legitimately declares hundreds of megabytes. Eight
 * megabytes is far past any real row: the largest columns here are a memory's text and a
 * Tiptap document, and the app's own note editor stops at two.
 */
const AFR_MAX_ROW_BYTES = 8 * 1024 * 1024;

/**
 * Rows per INSERT.
 *
 * The cap is half a million rows and a round trip each would be a restore measured in hours.
 * A batch never straddles a table — rank is non-decreasing and ranks are unique, so a table's
 * rows are contiguous — and never straddles a rank dependency for the same reason.
 */
const BRAIN_INSERT_BATCH = 500;

const NEWLINE = 0x0a;

export interface BrainImportInput {
  reader: AfrReadable;
  sink: BrainImportSink;
  mode: RestoreMode;
  budget: ImportBudget;
  /**
   * The authenticated caller. Every `owner` column becomes this, whatever the archive says
   * — the one thing that makes "restore" different from "adopt somebody else's data".
   */
  ownerUserId: string;
  /** Import time, for clamping provenance timestamps. Injected so tests are not clocks. */
  now?: number;
}

/**
 * Replay one brain archive into rows.
 *
 * `mode` changes nothing here, and that is deliberate: every unique constraint in this domain
 * is scoped by a column the restore reissues, so a restored brain cannot collide with one the
 * account already has and there is no conflict to resolve. `merge` and `replace` differ only
 * at commit — one leaves the existing brains alone, the other deletes them in the same
 * transaction — which is `commit-brain.ts`'s decision, not this file's. The mode travels in the
 * report because the audit row records what the user asked for.
 *
 * The one place the mode is visible from in here is `sink.hasDefaultBrain()`: under `replace`
 * the sink answers about the brains that will *survive*, so the archive's first brain becomes
 * the default rather than the account ending the restore without one.
 */
export async function importBrain(input: BrainImportInput): Promise<ImportReport> {
  const { reader, sink, mode, budget } = input;
  assertWithinRowCaps("brain", reader.summary.counts);

  const plan = await readIndex(reader);
  const mapper = new RowMapper(input.ownerUserId, input.now ?? Date.now(), await sink.hasDefaultBrain());

  let table: AccountTable | null = null;
  let batch: Record<string, unknown>[] = [];
  let rows = 0;

  const flush = async (): Promise<void> => {
    if (table === null || batch.length === 0) return;
    const sending = batch;
    batch = [];
    await sink.insert(table, sending);
  };

  for await (const text of rowLines(reader.readPayload(), budget)) {
    if (rows >= plan.length) {
      throw new AfrCorruptError("the payload carries a row past the last index line");
    }
    const entry = plan[rows];
    rows += 1;
    const where = `payload row ${rows}`;
    // A table's rows are contiguous — rank is non-decreasing and ranks are unique — so a
    // change of table is a group boundary, and a batch never straddles one.
    if (table !== null && entry.table !== table) await flush();
    table = entry.table;
    batch.push(mapper.map(entry.table, entry.rowId, text, where));
    if (batch.length >= BRAIN_INSERT_BATCH) await flush();
  }
  await flush();

  if (rows !== plan.length) {
    throw new AfrCorruptError(
      `the payload ended after ${rows} rows, the index lists ${plan.length}`
    );
  }

  await mapper.relink(sink);

  return { domain: "brain", mode, rows, bytes: budget.spent(), skipped: 0, renamed: 0 };
}

/* ── the INDEX: a directory the payload is held to ────────────────────────── */

/**
 * One row, as the INDEX named it.
 *
 * `table` is the descriptor itself rather than its name, which costs nothing — thirteen
 * shared references for half a million rows — and moves the "is this table even carried"
 * refusal to the line that made the claim, where the line number is still known.
 */
interface BrainRow {
  table: AccountTable;
  rowId: string;
}

/**
 * The whole INDEX, buffered, checked against the SUMMARY's own arithmetic.
 *
 * Buffering is not a choice: the format puts its table of contents in front of its data
 * (§5.1), and the payload is only meaningful paired with it. Two orderings are enforced on
 * the way through, and they are what the single-pass insert rests on — rank non-decreasing,
 * so every reference is already inserted, and `orderKey` strictly ascending, so the archive
 * cannot describe two rows as occupying one position.
 */
async function readIndex(reader: AfrReadable): Promise<BrainRow[]> {
  const plan: BrainRow[] = [];
  let rank = 0;
  let order = -1;
  let memories = 0;

  for await (const line of reader.indexLines()) {
    const entry = decodeBrainEntry(line.text, line.where);
    const table = accountTable("brain", entry.table, line.where);
    if (table.rank < rank) {
      throw new AfrCorruptError(`${line.where} lists ${table.name} after a table that follows it`);
    }
    if (entry.orderKey <= order) {
      throw new AfrCorruptError(`${line.where} is out of order`);
    }
    rank = table.rank;
    order = entry.orderKey;
    if (table.name === "memories") memories += 1;
    plan.push({ table, rowId: entry.rowId });
  }

  const counts = reader.summary.counts;
  if (plan.length !== counts.rows) {
    throw new AfrCorruptError(`index lists ${plan.length} rows, summary declared ${counts.rows}`);
  }
  if (memories !== counts.memories) {
    throw new AfrCorruptError(
      `index lists ${memories} memories, summary declared ${counts.memories}`
    );
  }
  return plan;
}

/* ── the payload: NDJSON, one line per row ────────────────────────────────── */

const EMPTY = Buffer.alloc(0);

/**
 * The payload's chunks, cut back into lines.
 *
 * Three refusals live here rather than anywhere else, because this is the only place that
 * sees the bytes as bytes:
 *
 *   - **The budget is charged per chunk**, before the chunk is looked at. §11 does not trust
 *     the size an archive declares, and the SUMMARY's `totalBytes` is what stage 2 reserved
 *     quota against — so a payload that delivers more than it promised is stopped as it
 *     arrives, not after the disk is full.
 *   - **A row has a ceiling.** A line must be whole before it can be parsed, and the byte
 *     budget alone would let one 400 MB line through on an account whose archive legitimately
 *     declares that much in total.
 *   - **The last line must be terminated.** A truncated download ends mid-row, and half a row
 *     of JSON that happens to parse is the one failure mode a digest at the end would catch
 *     too late to matter.
 */
async function* rowLines(
  payload: AsyncIterable<Buffer>,
  budget: ImportBudget
): AsyncGenerator<string, void, void> {
  let held = EMPTY;

  for await (const piece of payload) {
    budget.spend(piece.length);
    let from = 0;
    for (;;) {
      const at = piece.indexOf(NEWLINE, from);
      if (at < 0) break;
      const tail = piece.subarray(from, at);
      const line = held.length === 0 ? tail : Buffer.concat([held, tail]);
      held = EMPTY;
      from = at + 1;
      if (line.length > AFR_MAX_ROW_BYTES) {
        throw new AfrCorruptError(`a payload row is longer than ${AFR_MAX_ROW_BYTES} bytes`);
      }
      yield line.toString("utf8");
    }
    if (from >= piece.length) continue;
    // Copied rather than kept as a view: a `subarray` of a 4 MiB chunk holds the whole chunk
    // alive for as long as the partial line does.
    const rest = Buffer.from(piece.subarray(from));
    held = held.length === 0 ? rest : Buffer.concat([held, rest]);
    if (held.length > AFR_MAX_ROW_BYTES) {
      throw new AfrCorruptError(`a payload row is longer than ${AFR_MAX_ROW_BYTES} bytes`);
    }
  }

  if (held.length > 0) {
    throw new AfrCorruptError("the payload's last row is not terminated");
  }
}

/* ── one row, remapped ────────────────────────────────────────────────────── */

/**
 * The archive's ids on one side, this account's rows on the other.
 *
 * Every mapping this class holds is built from lines it has already read, which is the whole
 * security argument: the only ids that exist after a restore are ids this restore issued, so
 * a `ref` can only ever resolve to a row from the same archive and the same caller. An
 * archive naming a row belonging to somebody else resolves to nothing.
 */
class RowMapper {
  /**
   * `<table> <archive id>` → the uuid this import minted for it.
   *
   * A space is an unambiguous separator here and not merely a convenient one: a table name
   * matches `BRAIN_TABLE_RE` and a row id `BRAIN_ROW_ID_RE`, and neither admits one.
   */
  private readonly ids = new Map<string, string>();
  /** Self-references, held back until every row of their table exists. */
  private readonly deferred: {
    table: AccountTable;
    column: string;
    rowId: string;
    label: string;
  }[] = [];
  /** Rebuilt review keys, to catch an archive filing one finding twice. */
  private readonly reviewKeys = new Set<string>();
  private defaulted: boolean;

  constructor(
    private readonly owner: string,
    private readonly now: number,
    hasDefaultBrain: boolean
  ) {
    this.defaulted = hasDefaultBrain;
  }

  /**
   * One payload line as the columns of one INSERT.
   *
   * A column the archive does not carry is left out of the row entirely rather than written as
   * NULL, so the database's own `DEFAULT` applies. That is what makes an archive written by an
   * older version restorable: a column added since is simply absent, and absent is a state the
   * schema already has an answer for.
   */
  map(
    table: AccountTable,
    rowId: string,
    text: string,
    where: string
  ): Record<string, unknown> {
    const raw = asRecord(parseRow(text, where), where);
    const values: Record<string, unknown> = {};
    const decided: string[] = [];

    for (const [column, rule] of Object.entries(table.columns)) {
      switch (rule.rule) {
        case "drop":
          // Generated, derived, or bookkeeping of another server. Naming a generated column
          // in an INSERT is an error in Postgres, so this is not merely a value we ignore.
          continue;

        case "id":
          values[column] = this.mint(table, rowId, raw[column], column, where);
          continue;

        case "owner":
          // §10 — scope comes from the authenticated caller, never from the file. The archive
          // carries no owner column at all, so there is no NULL here to preserve.
          values[column] = this.owner;
          continue;

        case "ref":
          values[column] = this.reference(
            { table, column, rowId, where },
            rule.table,
            rule.nullable === true,
            refLabel(raw, column, where)
          );
          continue;

        case "time": {
          const ms = timeValue(raw, column, where);
          if (ms === null) continue;
          // A row claiming to have been written next year sorts above everything real, in
          // every list, forever. A validity window is the documented exception.
          values[column] = new Date(rule.future === "allowed" ? ms : Math.min(ms, this.now));
          continue;
        }

        case "server":
          // After the loop: a decision may read a reference this same row has yet to resolve.
          decided.push(column);
          continue;

        case "carry":
          if (raw[column] !== undefined) values[column] = raw[column];
          continue;

        default:
          // `path` and `payload` are the files domain's spellings — a brain row carrying one
          // is a descriptor mistake, not a damaged archive.
          throw new Error(`${table.name}.${column} has a rule the brain importer cannot apply`);
      }
    }

    for (const column of decided) this.decide(table, column, values, where);
    assertChecks(table, values, where);
    return values;
  }

  /**
   * A fresh primary key, recorded under the name the archive gave the row.
   *
   * The INDEX and the payload both name the row, and they have to agree — the INDEX is the
   * directory every reference is resolved through, so a payload row carrying a different id
   * would put the mapping and the data out of step. A repeated id is refused for the same
   * reason: two rows claiming one name make every reference to it ambiguous, and an archive
   * our own exporter wrote cannot contain one.
   */
  private mint(table: AccountTable, rowId: string, carried: unknown, column: string, where: string): string {
    if (carried !== rowId) {
      fail(`${where}.${column} is not the id the index gave this row`);
    }
    const key = `${table.name} ${rowId}`;
    if (this.ids.has(key)) {
      fail(`${where} reuses an id ${table.name} has already used`);
    }
    const id = randomUUID();
    this.ids.set(key, id);
    return id;
  }

  /**
   * One reference, resolved through the mapping — or refused, or dropped.
   *
   * The three outcomes are §11's, and the difference between the last two is the difference
   * between a broken archive and a lossy one. A dangling **non-nullable** reference means the
   * archive claims a row it does not contain, so it is not a whole archive and there is
   * nothing to restore it as. A dangling **nullable** one becomes NULL: "this memory was
   * filed under a project" is a fact a restore may lose without losing the memory.
   */
  private reference(
    at: { table: AccountTable; column: string; rowId: string; where: string },
    target: string,
    nullable: boolean,
    label: string | null
  ): string | null {
    if (target === at.table.name) {
      // The self-reference — `memories.superseded_by_id` and anything shaped like it. Its
      // target may be thousands of lines further on, so the column goes in NULL and
      // `relink()` fills it once every row of the table exists.
      if (label !== null) {
        this.deferred.push({ table: at.table, column: at.column, rowId: at.rowId, label });
      }
      return null;
    }
    const resolved = label === null ? undefined : this.ids.get(`${target} ${label}`);
    if (resolved !== undefined) return resolved;
    if (!nullable) {
      fail(
        label === null
          ? `${at.where}.${at.column} names no ${target}, and every row must`
          : `${at.where}.${at.column} names a ${target} this archive does not carry`
      );
    }
    return null;
  }

  /**
   * The three columns this domain lets the destination decide.
   *
   * Keyed by name and exhaustive on purpose: a `server` column is by definition one whose
   * value is a decision, and a decision cannot be inferred from the rule. So a new one added
   * to the descriptor stops here — loudly, in the tests — instead of silently arriving as NULL
   * in somebody's restore.
   */
  private decide(
    table: AccountTable,
    column: string,
    values: Record<string, unknown>,
    where: string
  ): void {
    switch (`${table.name}.${column}`) {
      case "brains.is_default": {
        // `brains_owner_default_unique` is a partial unique on `(owner_user_id) WHERE
        // is_default` — the one constraint in this domain scoped by a column the restore does
        // not reissue. So the first brain of an account without one becomes the default, and
        // every brain arriving beside one does not. Losing the flag is a preference, not data.
        const first = !this.defaulted;
        values[column] = first;
        this.defaulted = true;
        return;
      }

      case "memories.deleted_at":
        // Left out entirely, which is NULL. The export selects live rows only, so a restored
        // memory that arrived in the Recycle Bin would be content the user already threw away.
        return;

      case "brain_review_items.dedupe_key":
        values[column] = this.reviewKey(values, where);
        return;

      default:
        throw new Error(`${table.name}.${column} is a server column with no decision here`);
    }
  }

  /**
   * A review finding's identity, rebuilt from the ids this restore issued.
   *
   * The archive's own `dedupe_key` names rows that no longer exist, and a stale one would let
   * the next health scan file the same finding a second time. This is `reviewDedupeKey()` from
   * the brain feature, which this feature may not import — the boundary is deliberate, and
   * `tests/backup-account-import-brain.test.ts` holds the two spellings equal.
   *
   * A repeat is refused rather than left to the unique index: `(brain_id, dedupe_key)` is
   * unique, remapping is one-to-one, so a legitimate archive cannot contain two findings that
   * collapse onto one key — and a crafted one would otherwise surface as a constraint
   * violation instead of a numbered refusal.
   */
  private reviewKey(values: Record<string, unknown>, where: string): string {
    const kind = typeof values.kind === "string" ? values.kind : "";
    const ids = [values.memory_id, values.related_memory_id].filter(
      (id): id is string => typeof id === "string" && id.length > 0
    );
    const key = `${kind}:${ids.sort().join(":")}`;
    const scoped = `${String(values.brain_id)} ${key}`;
    if (this.reviewKeys.has(scoped)) {
      fail(`${where} repeats a review finding this archive has already filed`);
    }
    this.reviewKeys.add(scoped);
    return key;
  }

  /**
   * The second pass: every self-reference, now that every row of its table exists.
   *
   * Grouped by column rather than issued per row, because "three thousand memories were
   * superseded" is three thousand UPDATEs otherwise. A pair whose target resolves to nothing
   * is left out rather than refused — the column is nullable by definition (a non-nullable
   * self-reference could not be inserted at all), and a memory whose successor was not
   * carried is still the memory.
   */
  async relink(sink: BrainImportSink): Promise<void> {
    if (this.deferred.length === 0) return;

    const groups = new Map<
      string,
      { table: AccountTable; column: string; pairs: { id: string; value: string }[] }
    >();

    for (const one of this.deferred) {
      const id = this.ids.get(`${one.table.name} ${one.rowId}`);
      if (id === undefined) {
        // Only reachable if a table carrying a self-reference had no `id` rule, which no
        // descriptor can pass `assertInsertOrder`. Ours, not the archive's.
        throw new Error(`${one.table.name}.${one.column} was deferred for a row with no id`);
      }
      const value = this.ids.get(`${one.table.name} ${one.label}`);
      if (value === undefined) continue;

      const key = `${one.table.name} ${one.column}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { table: one.table, column: one.column, pairs: [] };
        groups.set(key, group);
      }
      group.pairs.push({ id, value });
    }

    for (const group of groups.values()) {
      for (let at = 0; at < group.pairs.length; at += BRAIN_INSERT_BATCH) {
        const slice = group.pairs.slice(at, at + BRAIN_INSERT_BATCH);
        await sink.relink(group.table, group.column, slice);
      }
    }
  }
}

/* ── reading one line's worth of columns ──────────────────────────────────── */

/**
 * One payload line as JSON, or refusal #7.
 *
 * A line that does not parse is the ordinary shape of a truncated or tampered payload, so it
 * is damage rather than a bug — and the digest that would also catch it only verifies after
 * the last chunk, which is far too late to be the first line of defence.
 */
function parseRow(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return fail(`${where} is not JSON`);
  }
}

/**
 * A reference as the archive spells one: an opaque label, or nothing.
 *
 * `undefined` and `null` collapse to `null` here — a column the archive left out and one it
 * wrote as NULL both mean "this row names no target", and for a reference there is no third
 * reading. A label of the wrong *shape*, though, is not missing information: it is a claim the
 * exporter could not have written (`BRAIN_ROW_ID_RE` is exactly what it validates ids against),
 * so it is refused rather than quietly treated as absent.
 */
function refLabel(raw: Record<string, unknown>, column: string, where: string): string | null {
  const value = raw[column];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !BRAIN_ROW_ID_RE.test(value)) {
    fail(`${where}.${column} is not a row id`);
  }
  return value as string;
}

/**
 * A timestamp column, in epoch milliseconds, or nothing.
 *
 * Absent and NULL are again one answer, and the answer is "leave the column out of the INSERT
 * so the database's own `DEFAULT` decides" — which is what makes a `NOT NULL … DEFAULT now()`
 * column restorable from an archive that never carried it.
 */
function timeValue(raw: Record<string, unknown>, column: string, where: string): number | null {
  const value = raw[column];
  if (value === undefined || value === null) return null;
  return intField(raw, column, where, 1, MAX_TIMESTAMP);
}

/**
 * The row against the CHECK constraints of its own table.
 *
 * The predicates are shared with the exporter, which drops a row that fails one, so a
 * legitimate archive cannot reach the refusal here. See `domain/row-checks.ts`.
 */
function assertChecks(
  table: AccountTable,
  values: Record<string, unknown>,
  where: string
): void {
  const broken = rowCheckFailure(table, values);
  if (broken !== null) fail(`${where} breaks ${broken}`);
}

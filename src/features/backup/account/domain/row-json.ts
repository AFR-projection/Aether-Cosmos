/**
 * The serializer for payload rows — one NDJSON line per database row, and the bytes of
 * a note's body.
 *
 * `canonical.ts` cannot do this job, and the reason is worth writing down because the two
 * modules look like duplicates. The canonical writer serializes structures *this format
 * defines*: the header, the summary, the trailer, every AAD. It is therefore free to
 * refuse anything with more than one reasonable spelling — it drops `null` rather than
 * writing it, it rejects a float, it stops at 32 levels. Those refusals are what make an
 * HMAC over its output reproducible.
 *
 * A payload row is not ours. It is a `jsonb` column a user's browser wrote: a Tiptap
 * document, a review item's `evidence`, an agent's `scopes`. `[1, null, 2]` is a value
 * somebody stored, `0.82` is a confidence score, and a backup that refused to carry them
 * would be a backup that loses data. So this writer carries every JSON value there is.
 *
 * What it keeps from the canonical writer is determinism, and for one specific reason:
 * merge matches a file by the SHA-256 of its bytes (§7.5). If exporting the same note
 * twice produced two orderings of the same keys, the digests would differ and `merge`
 * would restore a second copy of a note the account already has. Sorted keys, no
 * whitespace, and `JSON.stringify` for strings — whose escaping is fully specified,
 * lone surrogates included — make the bytes a function of the value alone.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.2, §7.5.
 */

/**
 * Deep enough that no real document reaches it — Tiptap nests a few levels per list,
 * `evidence` is flat — and shallow enough to stop a recursion before the stack does.
 * A `jsonb` value cannot contain a cycle, so this is a depth guard and nothing more.
 */
const MAX_ROW_DEPTH = 128;

/**
 * A value that came out of a database column and is on its way into a payload line.
 *
 * `null` is a member here and is not in `CanonicalValue`; that difference is the whole
 * point of this module.
 */
export type RowValue =
  | string
  | number
  | boolean
  | null
  | readonly RowValue[]
  | { readonly [key: string]: RowValue | undefined };

/**
 * Not one of the nine refusals: nothing here is reachable from a hostile archive. The
 * export path is what serializes, and every input it hands over came from our own tables
 * through the column rules of `tables.ts`. Reaching this means a rule is wrong — a
 * timestamp that was never converted to epoch milliseconds, a `Buffer` in a column the
 * descriptor calls `carry` — which is a bug in the descriptor, not a damaged file.
 */
export class RowJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RowJsonError";
  }
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function describe(value: object): string {
  const name = value.constructor?.name;
  return name ? `a ${name}` : "an exotic object";
}

function writeValue(out: string[], value: RowValue, depth: number, path: string): void {
  if (depth > MAX_ROW_DEPTH) {
    throw new RowJsonError(`nesting at ${path} is deeper than ${MAX_ROW_DEPTH} levels`);
  }
  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        // `JSON.stringify` writes `null` for these, which would silently turn a number
        // into an absent value. Postgres `jsonb` cannot hold either one, so a NaN here
        // came from arithmetic on our side.
        throw new RowJsonError(`${String(value)} at ${path} is not a finite number`);
      }
      out.push(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      // `bigint` lands here on purpose. `JSON.parse` reads a 19-digit integer back as a
      // rounded float, so a column that genuinely needs that range must be carried as a
      // decimal string by an explicit column rule rather than silently mangled here.
      throw new RowJsonError(`${typeof value} at ${path} is not a JSON value`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  if (Array.isArray(value)) {
    out.push("[");
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out.push(",");
      const item = (value as readonly RowValue[])[index];
      if (item === undefined) {
        // A hole in an array. Dropping it would renumber everything after it and
        // writing `null` would invent a value, so it is refused instead.
        throw new RowJsonError(`${path}[${index}] is undefined`);
      }
      writeValue(out, item, depth + 1, `${path}[${index}]`);
    }
    out.push("]");
    return;
  }
  if (isPlainObject(value)) {
    const record = value as { readonly [key: string]: RowValue | undefined };
    // `undefined` is dropped and `null` is written. The asymmetry is deliberate: a
    // column the projector chose not to emit is absent, and a column whose value is SQL
    // NULL says so, and the importer needs to be able to tell those apart.
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort(compareCodeUnits);
    out.push("{");
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      if (index > 0) out.push(",");
      out.push(JSON.stringify(key), ":");
      writeValue(out, record[key] as RowValue, depth + 1, path ? `${path}.${key}` : key);
    }
    out.push("}");
    return;
  }
  // A `Date`, a `Buffer`, a Drizzle row wrapper. Each has more than one defensible
  // spelling, so the column rule converts first — a timestamp becomes epoch ms — and
  // anything that arrives unconverted stops here where the fix is obvious.
  throw new RowJsonError(`${describe(value)} at ${path} is not a JSON value`);
}

/** The deterministic text of a payload row. */
export function rowJsonString(value: RowValue): string {
  const out: string[] = [];
  writeValue(out, value, 0, "row");
  return out.join("");
}

/** The bytes a payload line carries, terminator not included. */
export function rowJsonBytes(value: RowValue): Buffer {
  return Buffer.from(rowJsonString(value), "utf8");
}

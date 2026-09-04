/**
 * The one canonical serializer.
 *
 * Every HMAC and every GCM additional-authenticated-data blob in the `.afrbak`
 * format is computed over bytes this module produced. That is the entire point: if
 * the exporter and the verifier can disagree about how a header serializes — key
 * order, one space, a float's last digit — then the HMAC is a lottery and the
 * format's integrity guarantee is decoration.
 *
 * The output is strict JSON (`JSON.parse` reads it back), narrowed by four rules:
 *
 *   * object keys sorted by UTF-16 code unit, no whitespace anywhere
 *   * integers only, as decimal, no `+` and no leading zeros
 *   * binary as base64 **without** padding
 *   * `undefined` and `null` are dropped from objects, never written
 *
 * Ordering is deliberately code-unit order and not `localeCompare`: collation
 * depends on ICU data and the process locale, which makes it exactly the kind of
 * environment detail an HMAC must never rest on.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.2.
 */

/**
 * Deep enough for any structure this format defines (the header nests three
 * levels), shallow enough that a cycle is reported instead of overflowing the
 * stack — a cycle is just infinite depth from here.
 */
const MAX_DEPTH = 32;

export type CanonicalPrimitive = string | number | bigint | boolean | Uint8Array;

export type CanonicalValue = CanonicalPrimitive | readonly CanonicalValue[] | CanonicalObject;

export interface CanonicalObject {
  readonly [key: string]: CanonicalValue | null | undefined;
}

/**
 * Not a {@link import("../../domain/errors").BackupError}, and that is deliberate:
 * reaching this means our own writer handed the serializer something it promised
 * never to hand it. There is no status code for that — the route layer's catch-all
 * 500 is the honest answer. Hostile input never arrives here unvalidated; the
 * verify path canonicalizes only shapes a Zod schema has already narrowed.
 */
export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

/** Base64 without `=` padding. */
export function toUnpaddedBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString("base64")
    .replace(/=+$/, "");
}

/**
 * The strict inverse. Node's base64 decoder is lenient — it skips characters it
 * does not recognise, tolerates padding in the middle, and ignores non-zero
 * trailing bits, so `"QQ"` and `"QR"` both decode to `0x41`. Re-encoding and
 * demanding the exact input back rejects all three at once, which matters because
 * a value that decodes one way and re-serializes another would break the very
 * byte-for-byte comparison this module exists to guarantee.
 */
export function fromUnpaddedBase64(text: string, path = "value"): Buffer {
  const decoded = Buffer.from(text, "base64");
  if (toUnpaddedBase64(decoded) !== text) {
    throw new CanonicalError(`${path} is not canonical unpadded base64`);
  }
  return decoded;
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function isPlainObject(value: object): value is CanonicalObject {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function describe(value: object): string {
  const name = value.constructor?.name;
  return name ? `a ${name}` : "an exotic object";
}

/* ── writers ──────────────────────────────────────────────────────────────── */

function writeNumber(out: string[], value: number, path: string): void {
  if (!Number.isInteger(value)) {
    // Catches NaN and both infinities too: neither is an integer.
    throw new CanonicalError(
      `${String(value)} at ${path} is not an integer — how a float prints is engine ` +
        `detail, and an HMAC over engine detail is a lottery`
    );
  }
  if (!Number.isSafeInteger(value)) {
    throw new CanonicalError(`${String(value)} at ${path} is beyond 2^53-1`);
  }
  out.push(String(value));
}

function writeBigInt(out: string[], value: bigint, path: string): void {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    // Rejected rather than written, because `JSON.parse` would round it: the
    // verifier would then canonicalize different bytes than the writer did. A
    // genuine u64 belongs in a fixed binary field (PREAMBLE, TRAILER) or in a
    // decimal string, both of which survive the round trip intact.
    throw new CanonicalError(
      `${value.toString()} at ${path} exceeds 2^53-1, which JSON.parse cannot read back`
    );
  }
  out.push(value.toString());
}

function writeArray(
  out: string[],
  value: readonly CanonicalValue[],
  depth: number,
  path: string
): void {
  out.push("[");
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) out.push(",");
    const item = value[index];
    if (item === undefined || item === null) {
      // Dropping it — the rule for objects — would silently renumber every element
      // after it, so an array says so instead.
      throw new CanonicalError(
        `${path}[${index}] is ${item === null ? "null" : "undefined"}`
      );
    }
    writeValue(out, item, depth + 1, `${path}[${index}]`);
  }
  out.push("]");
}

function writeObject(out: string[], value: CanonicalObject, depth: number, path: string): void {
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined && value[key] !== null)
    .sort(compareCodeUnits);

  out.push("{");
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index];
    if (index > 0) out.push(",");
    out.push(JSON.stringify(key), ":");
    writeValue(out, value[key] as CanonicalValue, depth + 1, path ? `${path}.${key}` : key);
  }
  out.push("}");
}

function writeValue(out: string[], value: CanonicalValue, depth: number, path: string): void {
  if (depth > MAX_DEPTH) {
    throw new CanonicalError(`nesting at ${path} is deeper than ${MAX_DEPTH} levels`);
  }
  switch (typeof value) {
    case "string":
      // `JSON.stringify` of a string is fully specified — including the lone-surrogate
      // escapes of well-formed stringify — so it is deterministic across engines.
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      writeNumber(out, value, path);
      return;
    case "bigint":
      writeBigInt(out, value, path);
      return;
    case "object":
      break;
    default:
      throw new CanonicalError(`${typeof value} at ${path} is not serializable`);
  }
  if (value === null) {
    throw new CanonicalError(`null at ${path}: drop the key rather than writing it`);
  }
  if (value instanceof Uint8Array) {
    out.push(JSON.stringify(toUnpaddedBase64(value)));
    return;
  }
  if (Array.isArray(value)) {
    writeArray(out, value as readonly CanonicalValue[], depth, path);
    return;
  }
  if (isPlainObject(value)) {
    writeObject(out, value, depth, path);
    return;
  }
  // Date, Map, Set and class instances are refused on purpose: each one has more
  // than one reasonable serialization, and picking one silently is how a format
  // acquires a version-2 problem. Callers convert first — a Date becomes epoch ms.
  throw new CanonicalError(`${describe(value)} at ${path} is not a plain object`);
}

/** The canonical text of a value. */
export function canonicalString(value: CanonicalValue): string {
  const out: string[] = [];
  writeValue(out, value, 0, "value");
  return out.join("");
}

/** The canonical bytes of a value — what every HMAC and AAD is actually taken over. */
export function canonicalBytes(value: CanonicalValue): Buffer {
  return Buffer.from(canonicalString(value), "utf8");
}

import { fromUnpaddedBase64 } from "./canonical";
import { AfrCorruptError } from "./errors";

/**
 * Reading one field out of a structure a stranger wrote.
 *
 * The `.afrbak` format has four parsed structures — HEADER, SUMMARY, and the two
 * shapes of INDEX line — and every one of them is hostile input. They share these
 * helpers rather than each carrying its own copy, for a reason that is about
 * security and not about line count: the rule "an unknown key is a damaged file,
 * not something to ignore" only holds if every structure enforces it, and three
 * near-copies of that check are three chances for one of them to drift into being
 * permissive.
 *
 * Two conventions everything here follows:
 *
 *   * The refusal is always {@link AfrCorruptError} — refusal #7, "this file is
 *     damaged". Specific `detail`, one fixed user-facing message.
 *   * `detail` never quotes a value back. It says which field, and what was wrong
 *     with its shape. `detail` reaches `activity_logs`, and an archive is written
 *     by whoever hands us the file.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §11.
 */

export function fail(detail: string): never {
  throw new AfrCorruptError(detail);
}

/**
 * Anything quoted out of the file gets flattened first.
 *
 * The `detail` string ends up in `activity_logs`. Without this, a crafted archive
 * could name a JSON key `"\n2026-09-03 admin deleted everything"` and write its own
 * line into the audit trail.
 */
export function safeLabel(text: string): string {
  return text.replace(/[^A-Za-z0-9_.\-]/g, "?").slice(0, 32);
}

/**
 * The first thing asked of anything parsed out of the file: is it even an object.
 *
 * Exported because a structure with two shapes has to read its discriminator before it
 * knows which key list to demand, and re-implementing this check at that call site is
 * how "an array is not an object" becomes true in one place and false in another.
 */
export function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${where} is not an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Exactly these keys, no more and no fewer — an unknown field is a damaged header.
 *
 * `keys` must already be sorted by code unit, because the comparison is positional
 * against `Object.keys(...).sort()`. Every caller spells its list alphabetically.
 */
export function exactKeys(
  value: unknown,
  keys: readonly string[],
  where: string
): Record<string, unknown> {
  const record = asRecord(value, where);
  const present = Object.keys(record).sort();
  if (present.length !== keys.length) {
    fail(`${where} has ${present.length} keys, expected ${keys.length}`);
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (present[index] !== keys[index]) {
      fail(`${where}.${safeLabel(present[index])} is not a field of this format`);
    }
  }
  return record;
}

/**
 * The same, where some fields are legitimately absent.
 *
 * The canonical writer drops `undefined` instead of writing `null` (§5.2), so an
 * optional field that has no value leaves no trace in the bytes at all — which means
 * "absent" and "present as null" cannot both be spellings of the same thing. An
 * unknown key is still a refusal; only the known-optional ones may be missing.
 */
export function knownKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  where: string
): Record<string, unknown> {
  const record = asRecord(value, where);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      fail(`${where}.${safeLabel(key)} is not a field of this format`);
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      fail(`${where}.${key} is missing`);
    }
  }
  return record;
}

export function intField(
  record: Record<string, unknown>,
  key: string,
  where: string,
  min: number,
  max: number
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(`${where}.${key} is not an integer`);
  }
  if (value < min || value > max) {
    fail(`${where}.${key} is ${value}, outside [${min}, ${max}]`);
  }
  return value;
}

export function stringField(
  record: Record<string, unknown>,
  key: string,
  where: string,
  pattern: RegExp
): string {
  const value = record[key];
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${where}.${key} is not a well-formed value`);
  }
  return value;
}

/**
 * Free text with a ceiling: an email, a version string, a file name.
 *
 * A charset regex is the wrong tool for these — real names hold any script there is —
 * so what is enforced instead is a length and the absence of the two character classes
 * that are never content: control characters (which Postgres answers with a 500 rather
 * than a 400, and which forge log lines) and the bidi/invisible marks that make one
 * string render as another. Written as escapes so this file stays readable in an editor
 * that would otherwise honour them, the way `shared/lib/security/entity-name.ts` writes
 * the same set.
 */
const NEVER_IN_TEXT = new RegExp(
  "[\\u0000-\\u001F\\u007F\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]"
);

export function textField(
  record: Record<string, unknown>,
  key: string,
  where: string,
  maxChars: number
): string {
  const value = record[key];
  if (typeof value !== "string") {
    fail(`${where}.${key} is not a string`);
  }
  if (value.length > maxChars) {
    fail(`${where}.${key} is ${value.length} characters, cap ${maxChars}`);
  }
  if (NEVER_IN_TEXT.test(value)) {
    fail(`${where}.${key} contains control or direction characters`);
  }
  return value;
}

export function bytesField(
  record: Record<string, unknown>,
  key: string,
  where: string,
  length: number
): Buffer {
  const value = record[key];
  if (typeof value !== "string") {
    fail(`${where}.${key} is not a base64 string`);
  }
  let decoded: Buffer;
  try {
    decoded = fromUnpaddedBase64(value);
  } catch {
    fail(`${where}.${key} is not canonical base64`);
  }
  if (decoded.length !== length) {
    fail(`${where}.${key} is ${decoded.length} bytes, expected ${length}`);
  }
  return decoded;
}


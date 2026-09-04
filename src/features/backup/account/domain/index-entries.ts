import { checkEntityName } from "@/shared/lib/security/entity-name";
import { canonicalBytes } from "./canonical";
import {
  asRecord,
  bytesField,
  exactKeys,
  fail,
  intField,
  stringField,
  textField,
} from "./fields";

/**
 * INDEX: one line per row the archive carries.
 *
 * NDJSON rather than one big array, because the importer reads it as a stream and an
 * array would have to be complete before it parsed. Each line is canonical JSON (§5.2),
 * so the same rows always produce the same bytes.
 *
 * Two shapes, one per domain:
 *
 *   files — a `folder` or a `file` line. Folders are listed explicitly and not implied
 *           by the paths of the files inside them, because an empty folder is content:
 *           a backup that silently drops it is a backup that lost something. This is
 *           also why `counts.folders` exists in the SUMMARY.
 *   brain — `{table, rowId, orderKey}`, a directory of what the payload holds. The rows
 *           themselves travel in CHUNKS as NDJSON; this is what lets a preview say how
 *           many memories and tags are coming without reading the payload at all.
 *
 * **Paths are validated here**, at the format boundary, before a single DB statement is
 * built. The validator is `checkEntityName` — the same one the normal upload path uses,
 * segment by segment. That is deliberate and it is the point of §11: `materializedPath`
 * is built by joining a parent path to a child name, so a *name* containing `/` forges a
 * path, and every subtree operation in this application selects rows by path prefix. A
 * folder called `a/b` at the root and a folder `b` inside a folder `a` would produce the
 * same string, and trashing one would sweep the other's rows. That bug class was closed
 * in `tests/materialized-path-prefix.test.ts`; an archive must not become its second
 * entrance.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5, §11.
 */

/**
 * The archive's own bounds on a path. Neither is a database constraint — `folders` has
 * no depth column limit and `text` has no length limit — so an archive claiming a
 * 10,000-deep chain would otherwise be a 10,000-statement insert chain that no
 * legitimate writer produces. Both are far above anything a person makes by hand.
 */
export const AFR_MAX_PATH_CHARS = 4096;
export const AFR_MAX_PATH_DEPTH = 256;

/** Bounded like the upload path's own value; the importer re-decides `Content-Type`. */
export const AFR_MAX_MIME_CHARS = 255;

/** Roughly the year 9999, as everywhere else in this format. */
const MAX_TIMESTAMP = 253_402_300_799_000;

/* ── paths ────────────────────────────────────────────────────────────────── */

/**
 * A path as the archive spells it: segments joined by `/`, no leading slash, no trailing
 * slash, and the root written as the empty string.
 *
 * Returns the segments, because every caller needs them: the importer walks them to find
 * or create each ancestor folder, and it must walk the same list the validator approved
 * rather than re-splitting the string a second time and possibly differently.
 */
export function parseArchivePath(raw: unknown, where: string): string[] {
  if (typeof raw !== "string") {
    fail(`${where}.path is not a string`);
  }
  if (raw.length > AFR_MAX_PATH_CHARS) {
    fail(`${where}.path is ${raw.length} characters, cap ${AFR_MAX_PATH_CHARS}`);
  }
  // The root, which is where a file at the top level of the account lives.
  if (raw === "") {
    return [];
  }
  // Refused before splitting, because splitting hides them: a leading slash makes an
  // empty first segment, a trailing one an empty last, and `//` an empty middle. Each
  // would be a different string that names the same place.
  if (raw.startsWith("/") || raw.endsWith("/")) {
    fail(`${where}.path has a leading or trailing separator`);
  }
  // A backslash is a separator on the platform this application is developed on, and
  // `checkEntityName` refuses it per segment — but refusing it here as well means the
  // depth count below cannot be understated by a segment that is secretly two.
  if (raw.includes("\\")) {
    fail(`${where}.path contains a backslash`);
  }

  const segments = raw.split("/");
  if (segments.length > AFR_MAX_PATH_DEPTH) {
    fail(`${where}.path is ${segments.length} deep, cap ${AFR_MAX_PATH_DEPTH}`);
  }
  for (const segment of segments) {
    // `checkEntityName` is the whole guard: it refuses `/`, `\`, control characters, the
    // invisible and bidi marks, `.` and `..`, a trailing dot, an empty name, and anything
    // over 255 characters. Its `reason` is one of a closed set of fixed sentences and
    // never quotes the value, so it is safe to carry into `detail`.
    const checked = checkEntityName(segment);
    if (!checked.ok) {
      fail(`${where}.path has a segment rejected: ${checked.reason}`);
    }
    // It also trims, and there the archive is stricter than the upload path on purpose.
    // A route may forgive ` notes` and store `notes`; an archive may not, because both
    // spellings would then name one folder while comparing as two different paths —
    // which is the prefix-ambiguity bug again, arriving by a quieter door.
    if (checked.name !== segment) {
      fail(`${where}.path has a segment with surrounding whitespace`);
    }
  }
  return segments;
}

/** The one spelling of a path the archive uses, rebuilt from approved segments. */
export function joinArchivePath(segments: readonly string[]): string {
  return segments.join("/");
}

/* ── files: one line per folder, one per file ─────────────────────────────── */

/**
 * A folder, carried in its own right.
 *
 * `path` is the folder itself, not its parent — `photos/2026`, not `photos`. The root is
 * never written as an entry; it exists for every account already.
 */
export interface AfrFolderEntry {
  kind: "folder";
  path: string;
  /** Epoch milliseconds. The importer keeps these, so a restore is not backdated to now. */
  createdAt: number;
  updatedAt: number;
}

export interface AfrFileEntry {
  kind: "file";
  /** Includes the file's own name: `photos/2026/beach.jpg`. */
  path: string;
  /** Plaintext bytes. Summed by the importer and checked against its reservation (§7.3). */
  size: number;
  /** Of the plaintext, 32 bytes. What makes a truncated payload a refusal, not a file. */
  sha256: Buffer;
  /**
   * What the source row claimed. Advisory: the importer re-decides `Content-Type` on the
   * way out, because a stored MIME is a string a stranger wrote and this one is doubly so.
   */
  mime: string;
  createdAt: number;
  updatedAt: number;
}

export type AfrFilesEntry = AfrFolderEntry | AfrFileEntry;

const FOLDER_KEYS = ["createdAt", "kind", "path", "updatedAt"] as const;
const FILE_KEYS = [
  "createdAt",
  "kind",
  "mime",
  "path",
  "sha256",
  "size",
  "updatedAt",
] as const;

export const SHA256_BYTES = 32;

/**
 * NDJSON, so the terminator is part of the line rather than something the caller
 * remembers to add. A missing newline would merge two entries into one unparseable
 * object, and the writer is the only place that can get that wrong.
 */
export const INDEX_LINE_TERMINATOR = "\n";

export function encodeFilesEntry(entry: AfrFilesEntry): Buffer {
  const common = {
    createdAt: entry.createdAt,
    kind: entry.kind,
    path: entry.path,
    updatedAt: entry.updatedAt,
  };
  const bytes =
    entry.kind === "folder"
      ? canonicalBytes(common)
      : canonicalBytes({
          ...common,
          mime: entry.mime,
          sha256: entry.sha256,
          size: entry.size,
        });
  return Buffer.concat([bytes, Buffer.from(INDEX_LINE_TERMINATOR, "utf8")]);
}

/**
 * One line, already stripped of its terminator by the reader.
 *
 * `where` names the line for the audit trail — `index line 4102` — because "a path was
 * rejected" in an archive of 200,000 of them is not something an operator can act on.
 */
export function decodeFilesEntry(line: string, where: string): AfrFilesEntry {
  const record = asRecord(parseLine(line, where), where);
  const kind = record.kind;
  if (kind !== "folder" && kind !== "file") {
    fail(`${where}.kind is neither folder nor file`);
  }

  if (kind === "folder") {
    exactKeys(record, FOLDER_KEYS, where);
    return {
      kind,
      path: joinArchivePath(entryPath(record.path, where)),
      createdAt: timestamp(record, "createdAt", where),
      updatedAt: timestamp(record, "updatedAt", where),
    };
  }

  exactKeys(record, FILE_KEYS, where);
  return {
    kind,
    path: joinArchivePath(entryPath(record.path, where)),
    size: intField(record, "size", where, 0, Number.MAX_SAFE_INTEGER),
    sha256: bytesField(record, "sha256", where, SHA256_BYTES),
    mime: textField(record, "mime", where, AFR_MAX_MIME_CHARS),
    createdAt: timestamp(record, "createdAt", where),
    updatedAt: timestamp(record, "updatedAt", where),
  };
}

/**
 * A path that names something, which the root does not.
 *
 * `parseArchivePath` accepts the empty string, because a *parent* of a top-level entry is
 * the root and that is a real answer. An entry itself is different: an empty path would
 * be a file with no name, or a folder that is the account root — which every account has
 * before a restore begins, so an importer asked to create it would either duplicate it or
 * silently do nothing.
 */
function entryPath(raw: unknown, where: string): string[] {
  const segments = parseArchivePath(raw, where);
  if (segments.length === 0) {
    fail(`${where}.path is empty, which names nothing`);
  }
  return segments;
}

/* ── brain: a directory of the rows the payload carries ───────────────────── */

/**
 * The table name as the writing instance spelled it.
 *
 * Shape only. *Which* tables an account backup may carry is policy that moves with the
 * schema and lives in the per-account table descriptor, and the importer checks
 * membership there — the format layer deliberately does not import it, because a byte
 * layout that knows the current table list becomes unreadable the next time the list
 * changes. What is enforced here is that the value cannot be anything but a lowercase
 * identifier, so nothing else could reach a query builder even by accident.
 */
export const BRAIN_TABLE_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * The row's id in the source database, opaque on purpose.
 *
 * It is not validated as a UUID: it is a key in the remapping table the importer builds
 * (§11 — ids are reissued, never trusted), so its only job is to be a stable label that
 * the payload's rows can point back at. Bounded and restricted to characters that are
 * inert everywhere, which is all a label needs to be.
 */
export const BRAIN_ROW_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface AfrBrainEntry {
  table: string;
  rowId: string;
  /**
   * Insertion order within the archive, ascending. It is what lets the importer insert a
   * memory before the link that references it without knowing the schema's dependency
   * graph at read time — the exporter, which does know it, encoded the order here.
   */
  orderKey: number;
}

const BRAIN_KEYS = ["orderKey", "rowId", "table"] as const;

export function encodeBrainEntry(entry: AfrBrainEntry): Buffer {
  const bytes = canonicalBytes({
    orderKey: entry.orderKey,
    rowId: entry.rowId,
    table: entry.table,
  });
  return Buffer.concat([bytes, Buffer.from(INDEX_LINE_TERMINATOR, "utf8")]);
}

export function decodeBrainEntry(line: string, where: string): AfrBrainEntry {
  const record = exactKeys(parseLine(line, where), BRAIN_KEYS, where);
  return {
    table: stringField(record, "table", where, BRAIN_TABLE_RE),
    rowId: stringField(record, "rowId", where, BRAIN_ROW_ID_RE),
    orderKey: intField(record, "orderKey", where, 0, Number.MAX_SAFE_INTEGER),
  };
}

/* ── shared ───────────────────────────────────────────────────────────────── */

function parseLine(line: string, where: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    fail(`${where} is not JSON`);
  }
}

/**
 * A row timestamp, bounded but not compared against its sibling.
 *
 * `updatedAt` before `createdAt` is not checked, unlike `summary.dateRange`: a range is
 * one claim about two ends and a backwards one is arithmetic that cannot be true, while
 * these are two independent column values that a clock adjustment on the source machine
 * can genuinely leave out of order. Refusing the whole archive for that would lose data
 * over a cosmetic oddity.
 */
function timestamp(record: Record<string, unknown>, key: string, where: string): number {
  return intField(record, key, where, 1, MAX_TIMESTAMP);
}

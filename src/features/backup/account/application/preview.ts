/**
 * §7.2's exact split: how many files a restore would write, skip and rename, before it runs.
 *
 * The only honest way to answer that question is to make the same decisions the importer makes,
 * so this module makes them with the importer's own parts — `readFilesIndex` for the plan and
 * `restoredName` for a collision — and reads the account's live rows through the same two
 * generators the import sink exposes. Nothing here writes, charges quota or touches the payload:
 * the caller has uploaded the archive's PREAMBLE, HEADER, SUMMARY and INDEX and nothing more,
 * which is exactly the prefix these numbers can be computed from.
 *
 * A preview is a promise about the future, and the future can move: a file uploaded between the
 * preview and the restore turns a "restore" into a "skip". The numbers are therefore *exact as
 * of now*, not guaranteed, and the endpoint that serves them says which. What they may never be
 * is derived from a rule the importer does not use — that would be a number nobody can reconcile
 * with the report afterwards.
 *
 * `brain` has no split. Its `merge` inserts every row under fresh UUIDs, so nothing is ever
 * skipped and nothing is ever renamed, and the SUMMARY's own counts already say everything
 * there is to say.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.2, §7.5.
 */

import { joinArchivePath } from "@backup/account/domain/index-entries";
import { assertWithinRowCaps } from "@backup/account/domain/summary";
import { readFilesIndex, restoredName } from "@backup/account/application/import-files";
import type {
  AfrReadable,
  FilesImportSink,
  RestoreMode,
} from "@backup/account/application/import-types";

/**
 * The read half of the import sink, and deliberately spelled as a slice of it rather than as its
 * own interface: if the sink's live readers change shape, this stops compiling instead of
 * quietly previewing yesterday's rules.
 */
export type FilesPreviewSource = Pick<FilesImportSink, "liveFolders" | "liveFiles">;

export interface FilesSplitPreview {
  mode: RestoreMode;
  /** File rows that would be written. */
  restored: number;
  /** Entries the account already holds at the same path with the same bytes (`merge` only). */
  skipped: number;
  /** Entries that would land beside a live file under `name (restored)` (`merge` only). */
  renamed: number;
  /** Folder rows that would be created, ancestors the archive left implicit included. */
  newFolders: number;
  /** Bytes that would be charged against the quota. A skipped entry costs nothing. */
  bytes: number;
}

/** Get-or-create, for the two path-keyed indexes the merge decision needs. */
function bucket(map: Map<string, Set<string>>, key: string): Set<string> {
  const existing = map.get(key);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  map.set(key, created);
  return created;
}

export async function planFilesSplit(input: {
  reader: AfrReadable;
  source: FilesPreviewSource;
  mode: RestoreMode;
}): Promise<FilesSplitPreview> {
  const { reader, source, mode } = input;
  // The INDEX is held in memory here exactly as it is during an import, so it is bounded by the
  // same refusal (#8) rather than by the caller's good intentions.
  assertWithinRowCaps("files", reader.summary.counts);

  const plan = await readFilesIndex(reader);

  /** Folder paths that exist, or that an earlier entry of this same plan would have created. */
  const known = new Set<string>();
  /** Live digests by path — §7.5's "already here". Empty in `replace`. */
  const present = new Map<string, Set<string>>();
  /** Names in use per parent folder: live ones, then the ones this plan takes. */
  const taken = new Map<string, Set<string>>();

  if (mode === "merge") {
    // `replace` adopts nothing on purpose: `FolderTree` creates every folder fresh, because a
    // restored file inside a folder the commit is about to soft-delete would come back invisible.
    for await (const row of source.liveFolders()) known.add(row.path);
    for await (const row of source.liveFiles()) {
      const cut = row.path.lastIndexOf("/");
      bucket(taken, cut < 0 ? "" : row.path.slice(0, cut)).add(row.path.slice(cut + 1));
      // A null digest never matches, exactly as in `import-files.ts`: an unknown checksum must
      // not be allowed to compare equal to anything, or a restore would skip the archive's copy
      // in favour of bytes it cannot vouch for.
      if (row.sha256 !== null) bucket(present, row.path).add(row.sha256.toLowerCase());
    }
  }

  let newFolders = 0;
  const ensure = (segments: readonly string[]): void => {
    for (let i = 0; i < segments.length; i += 1) {
      const path = segments.slice(0, i + 1).join("/");
      if (known.has(path)) continue;
      known.add(path);
      newFolders += 1;
    }
  };

  // Every folder entry, not only the ones a file needs — an empty folder is content.
  for (const folder of plan.folders) ensure(folder.path.split("/"));

  let restored = 0;
  let skipped = 0;
  let renamed = 0;
  let bytes = 0;

  for (const { entry } of plan.files) {
    const segments = entry.path.split("/");
    const wanted = segments[segments.length - 1];

    if (mode === "merge" && present.get(entry.path)?.has(entry.sha256.toString("hex")) === true) {
      skipped += 1;
      continue;
    }

    // Only for an entry that would actually be written, because that is when the importer asks
    // for the folder: a skipped file never creates its parent.
    ensure(segments.slice(0, -1));

    if (mode === "merge") {
      const siblings = bucket(taken, joinArchivePath(segments.slice(0, -1)));
      let name = wanted;
      if (siblings.has(wanted)) {
        name = restoredName(wanted, siblings);
        renamed += 1;
      }
      // The restored name, not the wanted one. It changes nothing for the ordinary collision —
      // `wanted` is already in the set — but an archive that also carries a literal
      // `report (restored).pdf` collides with it, and the importer would rename that too.
      siblings.add(name);
    }

    restored += 1;
    bytes += entry.size;
  }

  return { mode, restored, skipped, renamed, newFolders, bytes };
}

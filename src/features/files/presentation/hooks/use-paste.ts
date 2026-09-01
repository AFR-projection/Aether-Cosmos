"use client";

import { useCallback, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/shared/api/client";
import { apiErrorMessage, useFormat, useT } from "@/shared/lib/i18n";
import type { TParams, TranslationKey } from "@/shared/lib/i18n";
import { notify } from "@/shared/lib/system/notify-store";
import { recordActivity } from "@/shared/lib/activity/activity-store";
import {
  clearClipboard,
  dropClipboardEntries,
  type FileClipboard,
} from "@files/domain/services/clipboard";
import {
  hasConflicts,
  planPaste,
  resolveConflicts,
  type ConflictPolicy,
  type PasteBlockedReason,
  type PasteItemPlan,
  type PastePlan,
} from "@files/domain/services/paste-plan";

/**
 * Drives one paste from the clipboard to a destination folder.
 *
 * A paste is three server round trips, not one: ask what would happen, create the folder
 * skeleton, then push the files through in chunks. That shape exists for two reasons the
 * old single-request loop could not satisfy — the conflict dialog has to be answerable
 * *before* anything is written, and a 400-file paste has to be able to report progress
 * and stop halfway without leaving the server holding a half-finished job.
 *
 * The hook owns no destination state: everything it needs comes in on `run`, so the same
 * hook serves the toolbar button, Ctrl+V, and "Paste into" on a folder card.
 */

/** What the toolbar chip shows while a paste is running. */
export type PasteProgress = {
  /** `planning` and `structure` have no meaningful count yet. */
  phase: "planning" | "structure" | "transfer";
  done: number;
  total: number;
  mode: "copy" | "cut";
};

/** An open conflict dialog, waiting for the user to choose a policy. */
export type PasteConflict = {
  /** Only the items that actually collided, for the dialog's preview list. */
  files: PasteItemPlan[];
  folders: PasteItemPlan[];
  /** How many items the paste covers in total, collided or not. */
  total: number;
  mode: "copy" | "cut";
  /** `null` cancels the whole paste. */
  decide: (policy: ConflictPolicy | null) => void;
};

type ServerPlan = {
  mode: "copy" | "cut";
  destinationFolderId: string | null;
  items: Array<{
    kind: "file" | "folder";
    id: string;
    name: string;
    sizeBytes: number;
    isNote?: boolean;
  }>;
  missing: string[];
  denied: string[];
  existing: { files: string[]; folders: string[] };
  totals: { folders: number; files: number; bytes: number };
  oversized: Array<{ id: string; name: string; sizeBytes: number }>;
  quota: Array<{
    ok: boolean;
    requiredBytes: number;
    remainingBytes: number;
    quotaBytes: number;
  }>;
  limits: { maxFilesPerChunk: number };
};

type FoldersResponse = {
  folderMap: Record<string, string>;
  files: Array<{ id: string; targetFolderId: string; name: string; sizeBytes: number }>;
  created: number;
  moved: number;
  skipped: string[];
};

type FilesResponse = {
  results: Array<{ id: string; ok: boolean; newId?: string; name?: string; message?: string }>;
  copied: number;
  moved: number;
  failed: number;
  bytes: number;
};

/** One file's worth of work for a `files` chunk. */
type FileWork = {
  id: string;
  targetFolderId: string | null;
  name: string;
  replace?: boolean;
};

export type PasteRunInput = {
  clipboard: FileClipboard;
  /** Where the paste is aimed; `null` is the account root. */
  destinationFolderId: string | null;
  /** The destination and every ancestor, so "into its own subtree" is caught locally. */
  destinationPathIds: readonly string[];
  canEdit: boolean;
  trash: boolean;
  /** Shown in the activity line when the destination has a name the page knows. */
  destinationName?: string;
};

/** Reasons `planPaste` can refuse, mapped to the sentence the user sees. */
const BLOCKED_KEYS: Record<PasteBlockedReason, TranslationKey> = {
  PASTE_INTO_TRASH: "files.paste.blocked.trash",
  PASTE_INTO_SELF: "files.paste.blocked.self",
  PASTE_INTO_DESCENDANT: "files.paste.blocked.descendant",
  PASTE_CUT_SAME_FOLDER: "files.paste.blocked.sameFolder",
};

/** Mirrors the `items` cap on the endpoint's `folders` op. */
const MAX_FOLDERS_PER_REQUEST = 100;

/** Splits a work list into slices of at most `size`. */
function chunkList<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let at = 0; at < items.length; at += step) out.push(items.slice(at, at + step));
  return out;
}

/**
 * A refusal the user should read as a sentence, not a stack trace.
 *
 * Thrown by the stages so `run` has one place to turn a stop into a toast, instead of
 * every early return having to remember to notify and reset the progress chip.
 */
class PasteStop extends Error {
  readonly detail?: string;
  readonly tone: "warning" | "error";

  constructor(title: string, detail?: string, tone: "warning" | "error" = "error") {
    super(title);
    this.name = "PasteStop";
    this.detail = detail;
    this.tone = tone;
  }
}

/** Everything the stages need from the hook, passed explicitly so they stay testable. */
type PasteContext = {
  t: (key: TranslationKey, params?: TParams) => string;
  formatBytes: (bytes: number) => string;
  setProgress: (progress: PasteProgress | null) => void;
  /** Opens the conflict dialog and resolves with the chosen policy, or `null` to abort. */
  askPolicy: (open: Omit<PasteConflict, "decide">) => Promise<ConflictPolicy | null>;
  cancelled: () => boolean;
};

type PasteOutcome = {
  copied: number;
  /** Folders a copy had to re-create, counted separately from the files inside them. */
  created: number;
  moved: number;
  failed: number;
  /** Items the user chose not to overwrite, plus anything the server declined to touch. */
  skipped: number;
  /** Ids that reached their destination, so a cut can forget them. */
  settled: string[];
  cancelled: boolean;
  /** Left untouched because the transfer stopped early. */
  remaining: number;
};

/** The `planPaste` verdict that means "go ahead", narrowed once for the stages below. */
type LocalPlan = Extract<PastePlan, { type: "paste" }>;

/**
 * Ask the server what this paste would do.
 *
 * Read-only, and that is the point: the conflict dialog can only be answered honestly if
 * nothing has been written yet. Also the last chance to refuse cheaply — a copy that does
 * not fit in the quota stops here rather than half-way through 300 files.
 */
async function requestPlan(local: LocalPlan, ctx: PasteContext): Promise<ServerPlan> {
  const res = await apiFetch<ServerPlan>("/api/files/paste", {
    method: "POST",
    body: JSON.stringify({
      op: "plan",
      mode: local.mode,
      destinationFolderId: local.destinationFolderId,
      // Folders first: their skeleton must exist before their files can be told where to go.
      entries: [...local.folders, ...local.files].map((e) => ({ kind: e.kind, id: e.id })),
    }),
  });
  if (!res.success || !res.data) {
    throw new PasteStop(apiErrorMessage(res, ctx.t, "files.paste.failed"));
  }
  const plan = res.data;

  // Ids the server cannot resolve are gone for good — deleted here, in another tab, or by
  // the folder's owner. Forget them, so the next Ctrl+V is not a rerun of the same failure.
  if (plan.missing.length > 0) dropClipboardEntries(plan.missing);

  if (plan.items.length === 0) {
    throw new PasteStop(
      ctx.t("files.paste.nothing"),
      plan.denied.length > 0
        ? ctx.t("files.paste.deniedSome", { count: plan.denied.length })
        : undefined,
      "warning"
    );
  }

  const short = plan.quota.find((q) => !q.ok);
  if (short) {
    throw new PasteStop(
      ctx.t("files.paste.quotaShort"),
      ctx.t("files.paste.quotaDetail", {
        required: ctx.formatBytes(short.requiredBytes),
        remaining: ctx.formatBytes(Math.max(0, short.remainingBytes)),
      })
    );
  }

  return plan;
}

/**
 * Settle on a name for every item, asking the user only when something actually collides.
 *
 * The names come from the plan the server just returned, not from the clipboard: an item
 * renamed since it was copied should paste under its current name. `null` means the user
 * closed the dialog, which cancels the paste rather than picking a policy for them.
 */
async function decideNames(
  plan: ServerPlan,
  ctx: PasteContext
): Promise<PasteItemPlan[] | null> {
  const entries = plan.items.map((item) => ({
    kind: item.kind,
    id: item.id,
    name: item.name,
  }));
  const keepBoth = resolveConflicts(entries, plan.existing, "keep-both");
  if (!hasConflicts(keepBoth)) return keepBoth;

  const collided = keepBoth.filter((item) => item.conflicted);
  const policy = await ctx.askPolicy({
    files: collided.filter((item) => item.kind === "file"),
    folders: collided.filter((item) => item.kind === "folder"),
    total: keepBoth.length,
    mode: plan.mode,
  });
  if (policy === null) return null;
  return resolveConflicts(entries, plan.existing, policy);
}

/**
 * Build the folder skeleton (copy) or re-parent the folder rows (cut), and report the file
 * work the copied subtrees add. A cut contributes none: moving a folder row moves
 * everything beneath it in one statement.
 */
async function runFolderStage(
  plan: ServerPlan,
  going: readonly PasteItemPlan[],
  ctx: PasteContext
): Promise<{ files: FileWork[]; created: number; moved: number; skippedIds: string[] }> {
  const folderItems = going.filter((item) => item.kind === "folder");
  const result = { files: [] as FileWork[], created: 0, moved: 0, skippedIds: [] as string[] };
  if (folderItems.length === 0) return result;

  ctx.setProgress({ phase: "structure", done: 0, total: folderItems.length, mode: plan.mode });

  // The endpoint caps a batch at 100 roots. Slices run in order so the second one sees the
  // names the first one claimed and picks `docs (3)` rather than a second `docs (2)`.
  for (const slice of chunkList(folderItems, MAX_FOLDERS_PER_REQUEST)) {
    const res = await apiFetch<FoldersResponse>("/api/files/paste", {
      method: "POST",
      body: JSON.stringify({
        op: "folders",
        mode: plan.mode,
        destinationFolderId: plan.destinationFolderId,
        items: slice.map((item) => ({ id: item.id, name: item.name })),
      }),
    });
    if (!res.success || !res.data) {
      throw new PasteStop(apiErrorMessage(res, ctx.t, "files.paste.failed"));
    }
    result.created += res.data.created;
    result.moved += res.data.moved;
    result.skippedIds.push(...res.data.skipped);
    for (const file of res.data.files) {
      result.files.push({ id: file.id, targetFolderId: file.targetFolderId, name: file.name });
    }
  }

  return result;
}

/**
 * Push the files through in chunks, checking for cancellation between them.
 *
 * A chunk in flight always finishes: aborting mid-request would leave rows the client never
 * hears about. Cancelling therefore means "stop after this one", which is also what makes
 * the operation resumable — every chunk is independently complete.
 */
async function runFileStage(
  mode: LocalPlan["mode"],
  work: readonly FileWork[],
  chunkSize: number,
  ctx: PasteContext
): Promise<Omit<PasteOutcome, "skipped" | "created">> {
  let copied = 0;
  let moved = 0;
  let failed = 0;
  let done = 0;
  const settled: string[] = [];
  const stop = (cancelled: boolean): Omit<PasteOutcome, "skipped" | "created"> => ({
    copied,
    moved,
    failed,
    settled,
    cancelled,
    remaining: work.length - done,
  });

  ctx.setProgress({ phase: "transfer", done: 0, total: work.length, mode });

  for (const slice of chunkList(work, chunkSize)) {
    if (ctx.cancelled()) return stop(true);

    const res = await apiFetch<FilesResponse>("/api/files/paste", {
      method: "POST",
      body: JSON.stringify({ op: "files", mode, items: slice }),
    });

    if (!res.success || !res.data) {
      // Whatever refused this chunk — quota, rate limit, a dropped connection — will refuse
      // the next one too. Stop and report, rather than grinding through 15 more rejections.
      const message = apiErrorMessage(res, ctx.t, "files.paste.failed");
      if (done === 0) throw new PasteStop(message);
      notify({ title: message, tone: "error" });
      return stop(false);
    }

    copied += res.data.copied;
    moved += res.data.moved;
    failed += res.data.failed;
    for (const item of res.data.results) if (item.ok) settled.push(item.id);
    done += slice.length;
    ctx.setProgress({ phase: "transfer", done, total: work.length, mode });
  }

  return stop(false);
}

const NOTHING_DONE: PasteOutcome = {
  copied: 0,
  created: 0,
  moved: 0,
  failed: 0,
  skipped: 0,
  settled: [],
  cancelled: false,
  remaining: 0,
};

/** plan → names → folder skeleton → file chunks. */
async function performPaste(local: LocalPlan, ctx: PasteContext): Promise<PasteOutcome> {
  const plan = await requestPlan(local, ctx);

  const named = await decideNames(plan, ctx);
  if (named === null) return { ...NOTHING_DONE, cancelled: true };

  const going = named.filter((item) => item.action !== "skip");
  let skipped = named.length - going.length;
  if (going.length === 0) return { ...NOTHING_DONE, skipped };

  if (plan.denied.length > 0) {
    notify({
      title: ctx.t("files.paste.deniedSome", { count: plan.denied.length }),
      tone: "warning",
    });
  }

  // A file past the single-part copy ceiling can never succeed. Saying so now beats letting
  // it fail at the end of a long transfer.
  const oversized = new Set(plan.oversized.map((item) => item.id));
  if (oversized.size > 0) {
    notify({ title: ctx.t("files.paste.oversized", { count: oversized.size }), tone: "warning" });
  }

  const structure = await runFolderStage(plan, going, ctx);
  const skippedFolders = new Set(structure.skippedIds);
  skipped += skippedFolders.size;

  const topFiles: FileWork[] = going
    .filter((item) => item.kind === "file")
    .map((item) => ({
      id: item.id,
      targetFolderId: plan.destinationFolderId,
      name: item.name,
      replace: item.action === "replace" ? true : undefined,
    }));

  // Folder rows that landed count as settled too, so a cut can drop them from the clipboard.
  const settledFolders = going
    .filter((item) => item.kind === "folder" && !skippedFolders.has(item.id))
    .map((item) => item.id);

  const work = [...topFiles, ...structure.files].filter((item) => !oversized.has(item.id));
  const oversizedInWork = topFiles.length + structure.files.length - work.length;

  if (work.length === 0) {
    return {
      ...NOTHING_DONE,
      created: structure.created,
      moved: structure.moved,
      failed: oversizedInWork,
      skipped,
      settled: settledFolders,
    };
  }

  const transfer = await runFileStage(plan.mode, work, plan.limits.maxFilesPerChunk, ctx);
  return {
    copied: transfer.copied,
    created: structure.created,
    moved: transfer.moved + structure.moved,
    failed: transfer.failed + oversizedInWork,
    skipped,
    settled: [...settledFolders, ...transfer.settled],
    cancelled: transfer.cancelled,
    remaining: transfer.remaining,
  };
}

/** The "3 failed · 1 skipped" line under the result toast. */
function describeOutcome(outcome: PasteOutcome, t: PasteContext["t"]): string | undefined {
  const parts: string[] = [];
  if (outcome.failed > 0) parts.push(t("files.paste.someFailed", { count: outcome.failed }));
  if (outcome.skipped > 0) parts.push(t("files.paste.someSkipped", { count: outcome.skipped }));
  if (outcome.remaining > 0) {
    parts.push(t("files.paste.someRemaining", { count: outcome.remaining }));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Refresh the views the paste changed, report it, and — for a cut — forget what moved. */
function finishPaste(
  mode: LocalPlan["mode"],
  outcome: PasteOutcome,
  input: PasteRunInput,
  t: PasteContext["t"],
  queryClient: QueryClient
): void {
  const landed = mode === "copy" ? outcome.copied + outcome.created : outcome.moved;
  const activity: "copy" | "move" = mode === "copy" ? "copy" : "move";

  if (mode === "cut") {
    // Explorer empties the clipboard once a move lands. A partial run keeps whatever did
    // not move, so a retry covers exactly the remainder.
    if (outcome.settled.length > 0) dropClipboardEntries(outcome.settled);
    if (landed > 0 && outcome.failed === 0 && outcome.remaining === 0 && !outcome.cancelled) {
      clearClipboard();
    }
  }

  if (landed > 0 || outcome.failed > 0) {
    queryClient.invalidateQueries({ queryKey: ["files"] });
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["folder-path"] });
    queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  }

  const description = describeOutcome(outcome, t);

  if (outcome.cancelled) {
    const title = t("files.paste.cancelled", { count: landed });
    notify({ title, description, tone: "warning" });
    recordActivity(activity, title, "cancelled", {
      detail: description,
      total: landed + outcome.remaining,
      destination: input.destinationName,
    });
    return;
  }

  if (landed === 0) {
    notify({
      title:
        outcome.skipped > 0
          ? t("files.paste.allSkipped", { count: outcome.skipped })
          : t("files.paste.nothing"),
      description,
      tone: "warning",
    });
    return;
  }

  const title =
    mode === "copy"
      ? t("files.paste.doneCopy", { count: landed })
      : t("files.paste.doneMove", { count: landed });
  notify({ title, description, tone: outcome.failed > 0 ? "warning" : "success" });
  recordActivity(activity, title, "done", {
    detail: description,
    total: landed,
    destination: input.destinationName,
  });
}

export function usePaste() {
  const t = useT();
  const { formatBytes } = useFormat();
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<PasteProgress | null>(null);
  const [conflict, setConflict] = useState<PasteConflict | null>(null);
  /** Read between chunks; a request already in flight is always allowed to finish. */
  const cancelRef = useRef(false);
  const busyRef = useRef(false);

  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  const run = useCallback(
    async (input: PasteRunInput): Promise<void> => {
      // Two pastes at once would race each other for the same destination names.
      if (busyRef.current) {
        notify({ title: t("files.paste.busy"), tone: "info" });
        return;
      }

      const clip = input.clipboard;
      const local = planPaste({
        clipboard: clip
          ? { mode: clip.mode, entries: clip.entries, sourceFolderId: clip.sourceFolderId }
          : null,
        destinationFolderId: input.destinationFolderId,
        destinationPathIds: input.destinationPathIds,
        canEdit: input.canEdit,
        trash: input.trash,
      });

      // Ctrl+V with an empty clipboard is not an error, it is a no-op.
      if (local.type === "none") return;
      if (local.type === "denied") {
        notify({ title: t("files.paste.blocked.readOnly"), tone: "warning" });
        return;
      }
      if (local.type === "blocked") {
        notify({ title: t(BLOCKED_KEYS[local.reason]), tone: "warning" });
        return;
      }

      busyRef.current = true;
      cancelRef.current = false;
      setProgress({ phase: "planning", done: 0, total: 0, mode: local.mode });

      const ctx: PasteContext = {
        t,
        formatBytes,
        setProgress,
        askPolicy: (open) =>
          new Promise<ConflictPolicy | null>((resolve) => {
            setConflict({
              ...open,
              decide: (policy) => {
                setConflict(null);
                resolve(policy);
              },
            });
          }),
        cancelled: () => cancelRef.current,
      };

      try {
        finishPaste(local.mode, await performPaste(local, ctx), input, t, queryClient);
      } catch (error) {
        const stop = error instanceof PasteStop ? error : null;
        notify({
          title: stop ? stop.message : t("files.paste.failed"),
          description: stop?.detail,
          tone: stop?.tone ?? "error",
        });
      } finally {
        busyRef.current = false;
        setProgress(null);
        setConflict(null);
      }
    },
    [t, formatBytes, queryClient]
  );

  return { progress, conflict, busy: progress !== null, run, cancel };
}

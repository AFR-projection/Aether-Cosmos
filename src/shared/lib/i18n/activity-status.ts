/**
 * Wording for the activity timeline, shared by the two surfaces that draw it:
 * the full activity page and the activity centre panel.
 *
 * Both tables are keyed by the store's own union values, so a type or status
 * added to `src/shared/lib/activity/activity-store.ts` is a compile error here until it is
 * given wording — which is the point. Two statuses that read the same in
 * English (`active`/`processing`, `done`/`completed`) share one key rather than
 * carrying duplicate text through three dictionaries.
 */

import type { TranslationKey } from "./dictionary";
import type { ActivityStatus, ActivityType } from "@/shared/lib/activity/activity-store";

const TYPE_KEYS: Record<ActivityType, TranslationKey> = {
  upload: "files.activity.type.upload",
  download: "files.activity.type.download",
  delete: "files.activity.type.delete",
  rename: "files.activity.type.rename",
  move: "files.activity.type.move",
  copy: "files.activity.type.copy",
  restore: "files.activity.type.restore",
  create_folder: "files.activity.type.createFolder",
};

const STATUS_KEYS: Record<ActivityStatus, TranslationKey> = {
  queued: "files.activity.status.queued",
  preparing: "files.activity.status.preparing",
  processing: "files.activity.status.processing",
  uploading: "files.activity.status.uploading",
  downloading: "files.activity.status.downloading",
  verifying: "files.activity.status.verifying",
  retrying: "files.activity.status.retrying",
  paused: "files.activity.status.paused",
  active: "files.activity.status.processing",
  done: "files.activity.status.completed",
  completed: "files.activity.status.completed",
  failed: "files.activity.status.failed",
  cancelled: "files.activity.status.cancelled",
};

/**
 * The stored type is a key (`create_folder`); a row has to read as a sentence.
 * Unknown values fall back to the generic word rather than to the raw key: the
 * timeline also renders history restored from localStorage, which can predate
 * the current union.
 */
export function activityTypeKey(type: string): TranslationKey {
  return TYPE_KEYS[type as ActivityType] ?? "files.activity.type.generic";
}

/**
 * Replaces a `charAt(0).toUpperCase()` fallback. Capitalising a raw status word
 * only ever produced English, and in Chinese there is no case to change.
 */
export function activityStatusKey(status: string): TranslationKey {
  return STATUS_KEYS[status as ActivityStatus] ?? "files.activity.status.processing";
}

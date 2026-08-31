import type {
  FileUploadStatus,
  UploadPartStatus,
  UploadSessionStatus,
} from "@/shared/infrastructure/db/schema";

/**
 * The file row is the availability authority. R2 operations may happen before
 * the final database commit, but no caller may skip the verification step.
 */
const FILE_TRANSITIONS: Readonly<Record<FileUploadStatus, readonly FileUploadStatus[]>> = {
  legacy_unverified: ["verifying", "failed"],
  created: ["uploading", "failed", "cancelled"],
  uploading: ["verifying", "failed", "cancelled"],
  verifying: ["ready", "failed"],
  ready: ["deleting", "inconsistent"],
  failed: ["uploading", "cancelled"],
  cancelled: [],
  deleting: ["delete_failed"],
  delete_failed: ["deleting"],
  inconsistent: ["verifying", "deleting"],
};

const SESSION_TRANSITIONS: Readonly<
  Record<UploadSessionStatus, readonly UploadSessionStatus[]>
> = {
  created: ["uploading", "failed", "cancelled", "expired"],
  uploading: ["verifying", "failed", "cancelled", "expired"],
  verifying: ["completed", "failed"],
  completed: [],
  failed: ["uploading", "cancelled", "expired"],
  cancelled: [],
  expired: [],
};

const PART_TRANSITIONS: Readonly<Record<UploadPartStatus, readonly UploadPartStatus[]>> = {
  pending: ["uploaded", "failed"],
  uploaded: ["uploaded", "failed"],
  failed: ["pending", "uploaded"],
};

export class InvalidUploadStateTransitionError extends Error {
  readonly code = "INVALID_UPLOAD_STATE_TRANSITION" as const;

  constructor(
    readonly resource: "file" | "session" | "part",
    readonly from: string,
    readonly to: string
  ) {
    super(`Invalid ${resource} upload state transition: ${from} -> ${to}`);
    this.name = "InvalidUploadStateTransitionError";
  }
}

function assertTransition<T extends string>(
  resource: "file" | "session" | "part",
  transitions: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T
): void {
  if (from === to) return;
  if (!transitions[from]?.includes(to)) {
    throw new InvalidUploadStateTransitionError(resource, from, to);
  }
}

export function assertFileUploadTransition(
  from: FileUploadStatus,
  to: FileUploadStatus
): void {
  assertTransition("file", FILE_TRANSITIONS, from, to);
}

export function canTransitionFileUpload(
  from: FileUploadStatus,
  to: FileUploadStatus
): boolean {
  try {
    assertFileUploadTransition(from, to);
    return true;
  } catch {
    return false;
  }
}

export function assertUploadSessionTransition(
  from: UploadSessionStatus,
  to: UploadSessionStatus
): void {
  assertTransition("session", SESSION_TRANSITIONS, from, to);
}

export function assertUploadPartTransition(
  from: UploadPartStatus,
  to: UploadPartStatus
): void {
  assertTransition("part", PART_TRANSITIONS, from, to);
}

export function isFileAvailable(status: FileUploadStatus): boolean {
  return status === "ready";
}

export function isFileTransferActive(status: FileUploadStatus): boolean {
  return status === "created" || status === "uploading" || status === "verifying";
}

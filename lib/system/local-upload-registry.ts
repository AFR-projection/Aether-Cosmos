"use client";

/**
 * Tracks fileIds that were uploaded from THIS browser tab, so the realtime SSE
 * "upload_complete" toast can be suppressed for them — the upload panel already
 * shows a richer batch-summary toast. SSE toasts still fire for uploads done on
 * OTHER devices (multi-device sync), which is the point of the realtime channel.
 */

const localUploads = new Map<string, number>();
const TTL_MS = 60_000;

export function clearLocalUploads(): void {
  localUploads.clear();
}

function sweep() {
  const now = Date.now();
  for (const [id, ts] of localUploads) {
    if (now - ts > TTL_MS) localUploads.delete(id);
  }
}

/** Mark a fileId as locally uploaded (called when the upload queue completes it). */
export function markLocalUpload(fileId: string | undefined | null): void {
  if (!fileId) return;
  sweep();
  localUploads.set(fileId, Date.now());
}

/**
 * Returns true once if this fileId was uploaded locally (and consumes the mark,
 * so a later genuinely-remote event with a recycled id isn't swallowed forever).
 */
export function consumeLocalUpload(fileId: string | undefined | null): boolean {
  if (!fileId) return false;
  sweep();
  if (localUploads.has(fileId)) {
    localUploads.delete(fileId);
    return true;
  }
  return false;
}

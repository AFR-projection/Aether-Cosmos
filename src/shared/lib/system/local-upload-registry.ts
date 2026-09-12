"use client";

/**
 * Tracks fileIds that were uploaded from THIS browser tab, so the realtime SSE
 * "upload_complete" toast can be suppressed for them — the upload panel already
 * shows a richer batch-summary toast. SSE toasts still fire for uploads done on
 * OTHER devices (multi-device sync), which is the point of the realtime channel.
 */

const localUploads = new Map<string, number>();
/**
 * The mark is written when /init hands back a fileId, and a large multipart
 * upload can spend many minutes between init and complete. A one-minute window
 * expired mid-transfer and let the tab toast its own upload again.
 */
const TTL_MS = 15 * 60_000;

/**
 * Marked but never consumed — a stuck entry must not pin memory forever.
 *
 * 500 was too small once uploads batched: two lanes hold up to
 * `BATCH_INIT_MAX_FILES` marks each from init until their batch-complete frame
 * arrives, and a lane that starts its next batch before the previous frame lands
 * overlaps them. Evicting a live mark makes the tab toast its OWN upload as if it
 * came from another device, and file it in Activity a second time. The TTL above
 * is what actually bounds this; the cap is only a backstop, so it should sit well
 * clear of a real folder upload. An entry is a uuid and a timestamp — 5,000 of
 * them is under a megabyte.
 */
const MAX_TRACKED = 5000;

export function clearLocalUploads(): void {
  localUploads.clear();
}

function sweep() {
  const now = Date.now();
  for (const [id, ts] of localUploads) {
    if (now - ts > TTL_MS) localUploads.delete(id);
  }
  // Map preserves insertion order, so the head of the iterator is the oldest.
  while (localUploads.size > MAX_TRACKED) {
    const oldest = localUploads.keys().next();
    if (oldest.done) break;
    localUploads.delete(oldest.value);
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

"use client";

import { encryptFile, type EncryptionMetaV1 } from "@/shared/lib/crypto/client-encryption";
import { markLocalUpload } from "@/shared/lib/system/local-upload-registry";
import { getActivityScopeId, syncTransferActivity, type ActivityStatus } from "@/shared/lib/activity/activity-store";
import {
  BATCH_COMPLETE_MAX_SESSIONS,
  BATCH_INIT_MAX_FILES,
  SMALL_FILE_MAX_BYTES,
} from "@files/application/commands/limits";

export type UploadItemStatus =
  | "queued"
  | "preparing"
  | "uploading"
  | "verifying"
  | "done"
  | "error"
  | "cancelled"
  | "resume_requires_file";

export interface UploadItem {
  id: string;
  file: File | null;
  folderId: string | null;
  remotePath: string;
  status: UploadItemStatus;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  speed: number;
  error?: string;
  fileId?: string;
  sessionId?: string;
  uploadId?: string;
  retries: number;
  encrypted?: boolean;
  mimeType?: string;
}

export interface UploadStats {
  total: number;
  completed: number;
  failed: number;
  active: number;
  queued: number;
  totalBytes: number;
  loadedBytes: number;
  overallProgress: number;
  speed: number;
  eta: number;
}

type UploadQueueEvents = {
  change: (items: UploadItem[], stats: UploadStats) => void;
  complete: (item: UploadItem) => void;
  error: (item: UploadItem, error: string) => void;
  allComplete: () => void;
};

type ApiResponse<T> = { success: boolean; data?: T; error?: string; code?: string };
type SessionPart = {
  partNumber: number;
  sizeBytes: number;
  etag: string | null;
  status: "pending" | "uploaded" | "failed";
};
type UploadSession = {
  sessionId: string;
  fileId: string;
  name: string;
  mimeType: string;
  objectKey: string;
  status: "created" | "uploading" | "verifying" | "completed" | "failed" | "cancelled" | "expired";
  fileStatus: string;
  uploadType: "single" | "multipart";
  uploadId: string | null;
  totalSizeBytes: number;
  partSizeBytes: number | null;
  retryCount: number;
  failureCode?: string | null;
  failureMessage?: string | null;
  expiresAt: string;
  parts: SessionPart[];
};
type InitResult = Omit<UploadSession, "name" | "mimeType" | "fileStatus" | "parts" | "expiresAt" | "retryCount" | "failureCode" | "failureMessage"> & {
  status: UploadSession["status"];
  totalSizeBytes: number;
  partSizeBytes: number | null;
  partCount: number;
  uploadId: string | null;
  uploadUrl: string | null;
};
/** One entry of `POST /api/uploads/batch-init`, which reports refusals per file. */
type BatchInitEntry =
  | ({ index: number; ok: true } & InitResult)
  | { index: number; ok: false; error: string; code: string };

const MAX_ACTIVE_FILES = 3;
/**
 * Direct-to-R2 PUTs in flight at once.
 *
 * Was 4, which is right for a handful of large files and badly wrong for a folder
 * of thousands of small ones: each small PUT is mostly latency, so the link sits
 * idle waiting for round trips. Small files get {@link SMALL_TRANSFER_CONCURRENCY}
 * instead — these go straight to object storage, not through the app, so the limit
 * that matters is the browser's own per-host cap rather than anything of ours.
 */
const MAX_ACTIVE_TRANSFERS = 4;
const SMALL_TRANSFER_CONCURRENCY = 12;
/** Batch lanes running at once, so init/complete of one overlaps the PUTs of another. */
const MAX_ACTIVE_BATCHES = 2;
const MAX_RETRIES = 3;
const API_BATCH_PARTS = 50;
const PROGRESS_THROTTLE_MS = 100;
const LARGE_ENCRYPTION_LIMIT = 64 * 1024 * 1024;
/** Ceiling for the exponential backoff between retries of a throttled API call. */
const MAX_BACKOFF_MS = 20_000;

function isActivityPopupPresentation(): boolean {
  return typeof window !== "undefined" && window.name === "FileActivityCenter";
}

let csrfToken: string | null = null;
let counter = 0;

function uid(): string {
  return `upload_${Date.now()}_${++counter}_${crypto.randomUUID()}`;
}

async function getCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const response = await fetch("/api/auth/csrf");
  const json = (await response.json()) as { data?: { token?: string } };
  if (!json.data?.token) throw new Error("Unable to obtain CSRF token");
  csrfToken = json.data.token;
  return csrfToken;
}

async function apiPost<T>(url: string, body: Record<string, unknown>): Promise<ApiResponse<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": await getCsrf() },
    body: JSON.stringify(body),
  });
  return (await response.json()) as ApiResponse<T>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `apiPost`, but a throttled or transiently-failed call waits and tries again.
 *
 * Rate limiting is the normal state of a large upload, not an error: the server
 * deliberately meters uploads, so a 429 means "later", not "give up". The old code
 * had neither a delay nor a distinction — a 429 consumed one of an item's three
 * retries immediately, so a burst of them exhausted every retry within a second and
 * a folder upload died with a pile of red rows while the server was merely asking
 * it to slow down.
 *
 * Backoff is exponential with jitter. The jitter matters more than the curve here:
 * a batch fans out dozens of parallel calls, and without it they would all retry on
 * the same tick and re-trip the limit together.
 */
async function apiPostResilient<T>(
  url: string,
  body: Record<string, unknown>,
  opts: { attempts?: number; aborted?: () => boolean } = {}
): Promise<ApiResponse<T>> {
  const attempts = opts.attempts ?? 5;
  let lastError = "REQUEST_FAILED";

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (opts.aborted?.()) throw new Error("CANCELLED");
    if (attempt > 0) {
      const backoff = Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1));
      await sleep(backoff / 2 + Math.random() * backoff);
      if (opts.aborted?.()) throw new Error("CANCELLED");
    }
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-csrf-token": await getCsrf() },
        body: JSON.stringify(body),
      });
      // 429 and 5xx are worth waiting out. A 4xx is a decision about this request
      // and repeating it verbatim would only produce the same answer.
      if (response.status === 429 || response.status >= 500) {
        lastError = response.status === 429 ? "RATE_LIMITED" : `HTTP_${response.status}`;
        continue;
      }
      return (await response.json()) as ApiResponse<T>;
    } catch (error) {
      // A dropped connection mid-flight: retry, same as a 5xx.
      lastError = error instanceof Error ? error.message : "NETWORK_ERROR";
    }
  }

  return { success: false, error: lastError, code: lastError };
}

async function apiGet<T>(url: string): Promise<ApiResponse<T>> {
  const response = await fetch(url);
  return (await response.json()) as ApiResponse<T>;
}

/**
 * Global cap on PUTs in flight, shared by both lanes so they cannot oversubscribe
 * the link between them. Each lane still applies its own, tighter pool on top: a
 * multipart file wants a few fat streams, a folder of small files wants many thin
 * ones, and the right number is not the same.
 */
class TransferLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.capacity) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.active++;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

const transferLimiter = new TransferLimiter(SMALL_TRANSFER_CONCURRENCY);

function mapPool<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const item = items[index++];
      if (item !== undefined) await fn(item);
    }
  }
  return Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker)).then(() => undefined);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Bounds concurrent filesystem reads during a directory walk.
 *
 * `traverseDirectory` descends into every subdirectory at once, which is what makes
 * a deep tree fast, but on a real project — `node_modules`, `.git` — that is tens of
 * thousands of simultaneous `readEntries`/`file()` calls. The browser serialises them
 * internally anyway, so the overshoot buys nothing and costs an unresponsive tab and,
 * on a big enough tree, outright failures.
 *
 * The slot is held ONLY around the filesystem call and never across the recursive
 * descent: a parent that waits on its children while holding a slot is exactly how a
 * semaphore wrapped around a recursive walk deadlocks. The release hands the slot
 * straight to the next waiter instead of decrementing, so a caller arriving in the
 * gap cannot slip past the limit.
 */
const FS_SCAN_CONCURRENCY = 32;
let fsActive = 0;
const fsWaiters: (() => void)[] = [];

async function fsAcquire(): Promise<() => void> {
  if (fsActive >= FS_SCAN_CONCURRENCY) await new Promise<void>((resolve) => fsWaiters.push(resolve));
  else fsActive++;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = fsWaiters.shift();
    if (next) next();
    else fsActive--;
  };
}

function putBlob(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  signal: { xhr?: XMLHttpRequest; aborted: boolean }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal.xhr = xhr;
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("NETWORK_ERROR")));
    xhr.addEventListener("timeout", () => reject(new Error("TIMEOUT")));
    xhr.addEventListener("abort", () => reject(new Error("CANCELLED")));
    xhr.open("PUT", url);
    xhr.timeout = 15 * 60 * 1000;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(blob);
  });
}

function putPart(
  url: string,
  blob: Blob,
  onProgress: (loaded: number, total: number) => void,
  signal: { xhrs: XMLHttpRequest[]; aborted: boolean }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal.xhrs.push(xhr);
    xhr.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) onProgress(event.loaded, event.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`PART_UPLOAD_FAILED (HTTP ${xhr.status})`));
        return;
      }
      const etag = xhr.getResponseHeader("ETag");
      if (!etag) reject(new Error("PART_UPLOAD_FAILED_MISSING_ETAG"));
      else resolve(etag);
    });
    xhr.addEventListener("error", () => reject(new Error("NETWORK_ERROR")));
    xhr.addEventListener("timeout", () => reject(new Error("TIMEOUT")));
    xhr.addEventListener("abort", () => reject(new Error("CANCELLED")));
    xhr.open("PUT", url);
    xhr.timeout = 15 * 60 * 1000;
    xhr.send(blob);
  });
}

export class UploadQueue {
  private readonly scopeId: string | null;
  private disposed = false;
  private items: UploadItem[] = [];
  /**
   * A Set per event, not one callback per event. The upload panel, the activity
   * centre and the activity page all listen for "change"; with a single slot the
   * last one to mount silently replaced the others, and the first one to unmount
   * tore down the survivor's subscription too.
   */
  private readonly listeners = new Map<keyof UploadQueueEvents, Set<(...args: never[]) => void>>();
  private paused = false;
  private activeWorkers = 0;
  private activeBatches = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotifyAt = 0;
  /** Last value published to the activity store per item, so unchanged rows are skipped. */
  private readonly published = new Map<string, string>();
  private speedSamples: number[] = [];
  private encryptEnabled = false;
  private encryptPassphrase: string | null = null;
  private abortSignals = new Map<string, { aborted: boolean; xhr?: XMLHttpRequest; xhrs: XMLHttpRequest[] }>();

  constructor(scopeId: string | null = getActivityScopeId()) {
    this.scopeId = scopeId;
    if (scopeId) void this.recoverActive();
  }

  getScopeId(): string | null { return this.scopeId; }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.notifyTimer = null;
    for (const signal of this.abortSignals.values()) {
      signal.aborted = true;
      signal.xhr?.abort();
      for (const xhr of signal.xhrs) xhr.abort();
    }
    this.abortSignals.clear();
    this.listeners.clear();
    this.published.clear();
    this.items = [];
  }

  setEncryption(enabled: boolean, passphrase: string | null) {
    this.encryptEnabled = enabled;
    this.encryptPassphrase = passphrase;
  }

  on<K extends keyof UploadQueueEvents>(event: K, cb: UploadQueueEvents[K]) {
    const bucket = this.listeners.get(event) ?? new Set<(...args: never[]) => void>();
    bucket.add(cb as (...args: never[]) => void);
    this.listeners.set(event, bucket);
  }

  /** Passing the callback removes just that subscriber; omitting it clears the event. */
  off<K extends keyof UploadQueueEvents>(event: K, cb?: UploadQueueEvents[K]) {
    if (!cb) {
      this.listeners.delete(event);
      return;
    }
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    bucket.delete(cb as (...args: never[]) => void);
    if (bucket.size === 0) this.listeners.delete(event);
  }

  private emit(event: keyof UploadQueueEvents, ...args: unknown[]) {
    const bucket = this.listeners.get(event);
    if (!bucket || bucket.size === 0) return;
    // Copied first: a listener is allowed to unsubscribe while being called.
    for (const cb of [...bucket]) (cb as (...a: unknown[]) => void)(...args);
  }

  private notify(immediate = false) {
    if (this.disposed || this.scopeId !== getActivityScopeId()) return;
    const now = Date.now();
    const delay = immediate ? 0 : Math.max(0, PROGRESS_THROTTLE_MS - (now - this.lastNotifyAt));
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.lastNotifyAt = Date.now();
      for (const item of this.items) {
        // The browser popup is a presentation surface. Its best-effort
        // recovery probe must not overwrite the opener's live transfer with a
        // local "resume requires file" snapshot.
        if (item.status === "resume_requires_file") continue;
        const phase: ActivityStatus = item.status === "done" ? "completed" : item.status === "error" ? "failed" : item.status === "cancelled" ? "cancelled" : item.status;
        // One file's progress tick used to re-publish every other item in the
        // queue as well — 200 activity-store writes per 100ms for a 200-file
        // batch, each one an O(n) rebuild plus a BroadcastChannel clone. Rows
        // that did not actually move are skipped. Speed is left out of the
        // signature on purpose: it only ever changes alongside the byte count.
        const signature = `${phase}|${item.uploadedBytes}|${item.totalBytes}|${item.fileId ?? ""}|${item.error ?? ""}`;
        if (this.published.get(item.id) === signature) continue;
        this.published.set(item.id, signature);
        syncTransferActivity({ id: item.id, type: "upload", name: item.file?.name ?? item.remotePath, phase, loaded: item.uploadedBytes, total: item.totalBytes, speed: item.speed, error: item.error, fileId: item.fileId });
      }
      this.emit("change", [...this.items], this.getStats());
    }, delay);
  }

  getStats(): UploadStats {
    // One pass. This runs on every throttled notify, and the seven separate
    // filter/reduce traversals it replaces were the second-biggest cost in a
    // large batch after the activity-store writes.
    let completed = 0;
    let failed = 0;
    let active = 0;
    let queued = 0;
    let totalBytes = 0;
    let loadedBytes = 0;
    for (const item of this.items) {
      switch (item.status) {
        case "done": completed++; break;
        case "error": failed++; break;
        case "preparing":
        case "uploading":
        case "verifying": active++; break;
        case "queued": queued++; break;
        default: break;
      }
      totalBytes += item.totalBytes;
      loadedBytes += Math.min(item.uploadedBytes, item.totalBytes);
    }
    const overallProgress = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
    const speed = this.currentSpeed();
    return { total: this.items.length, completed, failed, active, queued, totalBytes, loadedBytes, overallProgress, speed, eta: speed > 0 ? (totalBytes - loadedBytes) / speed : 0 };
  }

  private currentSpeed() {
    return this.speedSamples.length > 0
      ? this.speedSamples.reduce((sum, value) => sum + value, 0) / this.speedSamples.length
      : 0;
  }

  private trackSpeed(bytesPerSecond: number) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return;
    this.speedSamples.push(bytesPerSecond);
    if (this.speedSamples.length > 8) this.speedSamples.shift();
  }

  addFiles(files: File[], baseFolderId: string | null = null, pathPrefix = "") {
    for (const file of files) {
      this.items.push(this.newItem(file, baseFolderId, pathPrefix ? `${pathPrefix}/${file.name}` : file.name));
    }
    this.notify(true);
    void this.processNext();
  }

  addFolderStructure(entries: { file: File; relativePath: string; folderId: string | null }[]) {
    for (const entry of entries) this.items.push(this.newItem(entry.file, entry.folderId, entry.relativePath));
    this.notify(true);
    void this.processNext();
  }

  private newItem(file: File, folderId: string | null, remotePath: string): UploadItem {
    return { id: uid(), file, folderId, remotePath, status: "queued", progress: 0, uploadedBytes: 0, totalBytes: file.size, speed: 0, retries: 0, encrypted: this.encryptEnabled, mimeType: file.type || "application/octet-stream" };
  }

  private async recoverActive() {
    if (this.disposed || this.scopeId !== getActivityScopeId()) return;
    try {
      const response = await apiGet<{ uploads: UploadSession[] }>("/api/uploads/active");
      if (!response.success || !response.data) return;
      for (const upload of response.data.uploads) {
        if (this.disposed || this.scopeId !== getActivityScopeId()) return;
        if (this.items.some((item) => item.sessionId === upload.sessionId)) continue;
        this.items.push({ id: `recovered_${upload.sessionId}`, file: null, folderId: null, remotePath: upload.name, status: "resume_requires_file", progress: 0, uploadedBytes: upload.parts.filter((part) => part.status === "uploaded").reduce((sum, part) => sum + part.sizeBytes, 0), totalBytes: upload.totalSizeBytes, speed: 0, retries: upload.retryCount, error: "RESUME_REQUIRES_FILE", sessionId: upload.sessionId, fileId: upload.fileId, uploadId: upload.uploadId ?? undefined, mimeType: upload.mimeType });
      }
      this.notify(true);
    } catch {
      // Recovery is best effort; a normal newly selected file can still upload.
    }
  }

  /**
   * Whether an item takes the batched lane.
   *
   * Encryption is excluded because the bytes that go up are not the bytes on disk —
   * the size is only known after `encryptFile`, and batch-init has to state it
   * up front. Large files are excluded because the per-file route's resumability
   * is worth more to them than a saved handshake.
   */
  private isBatchable(item: UploadItem): boolean {
    return !!item.file && !item.encrypted && item.file.size <= SMALL_FILE_MAX_BYTES;
  }

  private async processNext() {
    if (this.disposed || this.scopeId !== getActivityScopeId() || this.paused) return;

    // The batched lane first: a folder upload is overwhelmingly small files, and
    // leaving them to the three per-file slots is what made a real project take
    // hours. Claimed synchronously, like the per-file slots below, so a second
    // turn of this loop cannot hand the same item to two lanes.
    while (this.activeBatches < MAX_ACTIVE_BATCHES) {
      const batch: UploadItem[] = [];
      for (const item of this.items) {
        if (batch.length >= BATCH_INIT_MAX_FILES) break;
        if (item.status === "queued" && this.isBatchable(item)) batch.push(item);
      }
      if (batch.length === 0) break;
      for (const item of batch) item.status = "preparing";
      this.activeBatches++;
      void this.runBatch(batch);
    }

    // Slot-based, not batch-based. The old version ran a pool over a slice of
    // three and awaited the whole slice, so two finished slots sat idle behind
    // one slow file. Each slot now pulls the next queued file immediately.
    while (this.activeWorkers < MAX_ACTIVE_FILES) {
      // Batchable items belong to the lane above, even when it is saturated:
      // taking them here would upload the same folder through two schedulers at
      // once and undo the batching.
      const next = this.items.find(
        (item) => item.status === "queued" && item.file && !this.isBatchable(item)
      );
      if (!next) break;
      // Claimed synchronously so the next turn of this loop cannot pick it again.
      next.status = "preparing";
      this.activeWorkers++;
      void this.runItem(next);
    }
    if (this.activeWorkers === 0 && this.activeBatches === 0 && this.items.length > 0 && this.getStats().active === 0) {
      this.emit("allComplete");
    }
  }

  /**
   * Record a failure the same way whichever lane hit it: requeue while the item
   * still has retries left, give up once it does not.
   */
  private failItem(item: UploadItem, message: string) {
    if ((item.status as UploadItemStatus) === "cancelled") return;
    item.error = message;
    item.status = item.retries < MAX_RETRIES ? "queued" : "error";
    if (item.status === "queued") item.retries++;
    this.emit("error", item, message);
  }

  private markDone(item: UploadItem) {
    item.uploadedBytes = item.totalBytes;
    item.progress = 100;
    item.status = "done";
    markLocalUpload(item.fileId);
    this.emit("complete", item);
  }

  /**
   * Upload a group of small files with one init call, one PUT each, and one
   * complete call per {@link BATCH_COMPLETE_MAX_SESSIONS}.
   *
   * The per-file path costs four app round trips per file (init, state, PUT,
   * complete). For 5,000 small files that is 20,000 requests against a metered
   * endpoint — the upload spent nearly all of its time in handshakes and then died
   * on the rate limit. Here the same 5,000 files cost 25 init calls, 25 complete
   * calls and 5,000 PUTs that go straight to object storage and are not metered by
   * us at all.
   */
  private async runBatch(items: UploadItem[]) {
    try {
      this.notify(true);
      const live = () => !this.disposed && this.scopeId === getActivityScopeId();
      if (!live()) return;

      const initialized = await apiPostResilient<{ results: BatchInitEntry[] }>(
        "/api/uploads/batch-init",
        {
          files: items.map((item) => ({
            filename: item.file!.name,
            mimeType: item.file!.type || "application/octet-stream",
            sizeBytes: item.file!.size,
            folderId: item.folderId,
            idempotencyKey: item.id,
            encrypted: false,
          })),
        }
      );

      if (!live()) return;
      if (!initialized.success || !initialized.data) {
        // The whole call failed, so nothing was reserved: every item goes back in
        // the queue on its own retry budget rather than dying as a group.
        for (const item of items) this.failItem(item, initialized.error ?? "UPLOAD_INIT_FAILED");
        this.notify(true);
        return;
      }

      const ready: { item: UploadItem; url: string; mime: string }[] = [];
      for (const entry of initialized.data.results) {
        const item = items[entry.index];
        if (!item || item.status === "cancelled") continue;
        if (!entry.ok) {
          // A per-file refusal — a blocked extension, quota, a folder that moved.
          // Retrying it verbatim would produce the same answer, so it is final.
          item.retries = MAX_RETRIES;
          this.failItem(item, entry.error);
          continue;
        }
        item.sessionId = entry.sessionId;
        item.fileId = entry.fileId;
        // Registered before the transfer, not after: the complete route publishes
        // its realtime event before returning, so it can reach this tab first.
        markLocalUpload(entry.fileId);
        item.totalBytes = entry.totalSizeBytes;
        if (entry.status === "completed") {
          this.markDone(item);
          continue;
        }
        if (!entry.uploadUrl) {
          this.failItem(item, "UPLOAD_URL_MISSING");
          continue;
        }
        ready.push({
          item,
          url: entry.uploadUrl,
          mime: item.file!.type || "application/octet-stream",
        });
      }
      this.notify(true);

      const uploaded: UploadItem[] = [];
      await mapPool(ready, SMALL_TRANSFER_CONCURRENCY, async ({ item, url, mime }) => {
        if (!live() || item.status === "cancelled") return;
        const signal = { aborted: false, xhrs: [] as XMLHttpRequest[] };
        this.abortSignals.set(item.id, signal);
        item.status = "uploading";
        let lastLoaded = 0;
        let lastTime = Date.now();
        try {
          const release = await transferLimiter.acquire();
          try {
            await putBlob(url, item.file!, mime, (loaded, total) => {
              item.uploadedBytes = loaded;
              item.progress = total > 0 ? (loaded / total) * 100 : 0;
              const now = Date.now();
              const elapsed = (now - lastTime) / 1000;
              if (elapsed >= 0.3) {
                const speed = (loaded - lastLoaded) / elapsed;
                item.speed = speed;
                this.trackSpeed(speed);
                lastLoaded = loaded;
                lastTime = now;
              }
              this.notify();
            }, signal);
          } finally {
            release();
          }
          // A zero-byte file never fires a progress event, so its bytes are
          // settled here rather than left at whatever the last tick said.
          item.uploadedBytes = item.totalBytes;
          item.status = "verifying";
          uploaded.push(item);
        } catch (error) {
          this.failItem(item, error instanceof Error ? error.message : "UPLOAD_FAILED");
        } finally {
          this.abortSignals.delete(item.id);
        }
        this.notify();
      });

      if (!live()) return;
      this.notify(true);

      for (const group of chunk(uploaded, BATCH_COMPLETE_MAX_SESSIONS)) {
        const completed = await apiPostResilient<{
          results: ({ sessionId: string; ok: true } | { sessionId: string; ok: false; error: string })[];
        }>("/api/uploads/batch-complete", {
          sessions: group.map((item) => ({ sessionId: item.sessionId })),
        });
        if (!live()) return;

        if (!completed.success || !completed.data) {
          for (const item of group) this.failItem(item, completed.error ?? "FINALIZATION_FAILED");
          continue;
        }
        const verdicts = new Map(completed.data.results.map((result) => [result.sessionId, result]));
        for (const item of group) {
          const verdict = item.sessionId ? verdicts.get(item.sessionId) : undefined;
          if (verdict && verdict.ok) this.markDone(item);
          else this.failItem(item, (verdict && !verdict.ok ? verdict.error : undefined) ?? "FINALIZATION_FAILED");
        }
        this.notify(true);
      }
    } finally {
      this.activeBatches--;
      if (!this.paused && !this.disposed) void this.processNext();
    }
  }

  private async runItem(item: UploadItem) {
    try {
      await this.processItem(item);
    } finally {
      this.activeWorkers--;
      if (!this.paused && !this.disposed) void this.processNext();
    }
  }

  private async processItem(item: UploadItem) {
    if (this.disposed || this.scopeId !== getActivityScopeId() || !item.file || item.status === "cancelled") return;
    item.status = "preparing";
    this.notify(true);
    try {
      let blob: Blob = item.file;
      let uploadSize = item.file.size;
      let uploadMime = item.file.type || "application/octet-stream";
      let encryptionMeta: EncryptionMetaV1 | undefined;
      if (item.encrypted && this.encryptPassphrase) {
        if (item.file.size > LARGE_ENCRYPTION_LIMIT) throw new Error("ENCRYPTION_LARGE_FILE_UNSUPPORTED");
        const encrypted = await encryptFile(item.file, this.encryptPassphrase);
        blob = encrypted.blob;
        uploadSize = encrypted.sizeBytes;
        uploadMime = "application/octet-stream";
        encryptionMeta = encrypted.meta;
      }

      const initialized = await apiPostResilient<InitResult>("/api/uploads/init", {
        filename: item.file.name,
        mimeType: item.file.type || "application/octet-stream",
        sizeBytes: uploadSize,
        folderId: item.folderId,
        idempotencyKey: item.id,
        encrypted: !!encryptionMeta,
        encryptionMeta,
      });
      if (!initialized.success || !initialized.data) throw new Error(initialized.error ?? "UPLOAD_INIT_FAILED");
      let init = initialized.data;
      item.sessionId = init.sessionId;
      item.fileId = init.fileId;
      // Registered now rather than after /complete. The complete route publishes
      // its realtime upload_complete event before returning, so the event can
      // reach this tab before the POST resolves — registering late let this tab
      // toast its own upload a second time through the realtime channel.
      markLocalUpload(init.fileId);
      item.uploadId = init.uploadId ?? undefined;
      item.totalBytes = init.totalSizeBytes;
      item.mimeType = uploadMime;

      if (init.status === "failed") {
        const retried = await apiPostResilient<InitResult>(`/api/uploads/${init.sessionId}/retry`, {});
        if (!retried.success || !retried.data) throw new Error(retried.error ?? "UPLOAD_RETRY_FAILED");
        init = retried.data;
      }
      if (init.status === "completed") {
        this.markDone(item);
        this.notify(true);
        return;
      }

      // The session's part list is only meaningful to a resumed multipart upload,
      // so it is fetched inside that branch. Asking for it on every single-part
      // upload added a whole round trip per file to no purpose.
      item.status = "uploading";
      this.notify(true);
      const signal = { aborted: false, xhrs: [] as XMLHttpRequest[] };
      this.abortSignals.set(item.id, signal);
      if (init.uploadType === "single") {
        if (!init.uploadUrl) throw new Error("UPLOAD_URL_MISSING");
        const startedAt = Date.now();
        let lastLoaded = 0;
        let lastTime = startedAt;
        const release = await transferLimiter.acquire();
        try {
          await putBlob(init.uploadUrl, blob, uploadMime, (loaded, total) => {
            item.uploadedBytes = loaded;
            item.progress = total > 0 ? (loaded / total) * 100 : 0;
            const now = Date.now();
            const elapsed = (now - lastTime) / 1000;
            if (elapsed >= 0.3) {
              const speed = (loaded - lastLoaded) / elapsed;
              item.speed = speed;
              this.trackSpeed(speed);
              lastLoaded = loaded;
              lastTime = now;
            }
            this.notify();
          }, signal);
        } finally {
          release();
        }
        item.status = "verifying";
        this.notify(true);
        const complete = await apiPostResilient<{ sessionId: string; fileId: string; name: string; status: "ready" }>(`/api/uploads/${init.sessionId}/complete`, {});
        if (!complete.success) throw new Error(complete.error ?? "FINALIZATION_FAILED");
      } else {
        if (!init.partSizeBytes || !init.partCount || !init.uploadId) throw new Error("MULTIPART_SESSION_INCOMPLETE");
        // Only a resumed upload has parts already on the server, and only this
        // branch can use them.
        const stateResponse = await apiGet<UploadSession>(`/api/uploads/${init.sessionId}`);
        if (!stateResponse.success || !stateResponse.data) throw new Error(stateResponse.error ?? "UPLOAD_STATE_FAILED");
        const state = stateResponse.data;
        const uploaded = new Map(state.parts.filter((part) => part.status === "uploaded" && part.etag).map((part) => [part.partNumber, part]));
        let committedBytes = [...uploaded.values()].reduce((sum, part) => sum + part.sizeBytes, 0);
        item.uploadedBytes = committedBytes;
        item.progress = item.totalBytes > 0 ? (item.uploadedBytes / item.totalBytes) * 100 : 0;
        const missingParts = Array.from({ length: init.partCount }, (_, index) => index + 1).filter((partNumber) => !uploaded.has(partNumber));
        const etags = new Map<number, string>([...uploaded.entries()].map(([number, part]) => [number, part.etag!]));
        const inFlightProgress = new Map<number, number>();
        let speedBytes = committedBytes;
        let speedAt = Date.now();
        for (let offset = 0; offset < missingParts.length; offset += API_BATCH_PARTS) {
          const partNumbers = missingParts.slice(offset, offset + API_BATCH_PARTS);
          const signed = await apiPostResilient<{ parts: { partNumber: number; sizeBytes: number; url: string }[] }>(`/api/uploads/${init.sessionId}/parts/sign`, { partNumbers }, { aborted: () => signal.aborted });
          if (!signed.success || !signed.data) throw new Error(signed.error ?? "PART_SIGNING_FAILED");
          await mapPool(signed.data.parts, MAX_ACTIVE_TRANSFERS, async (part) => {
            let attempt = 0;
            while (attempt < 3) {
              attempt++;
              try {
                const release = await transferLimiter.acquire();
                try {
                  const etag = await putPart(part.url, blob.slice((part.partNumber - 1) * init.partSizeBytes!, Math.min(part.partNumber * init.partSizeBytes!, blob.size)), (loaded, _total) => {
                    inFlightProgress.set(part.partNumber, loaded);
                    item.uploadedBytes = committedBytes + [...inFlightProgress.values()].reduce((sum, value) => sum + value, 0);
                    item.progress = item.totalBytes > 0 ? (item.uploadedBytes / item.totalBytes) * 100 : 0;
                    const now = Date.now();
                    const elapsed = (now - speedAt) / 1000;
                    if (elapsed >= 0.3) {
                      const speed = (item.uploadedBytes - speedBytes) / elapsed;
                      item.speed = speed;
                      this.trackSpeed(speed);
                      speedBytes = item.uploadedBytes;
                      speedAt = now;
                    }
                    this.notify();
                  }, signal);
                  etags.set(part.partNumber, etag);
                  const committed = await apiPostResilient(`/api/uploads/${init.sessionId}/parts/commit`, { partNumber: part.partNumber, etag }, { aborted: () => signal.aborted });
                  if (!committed.success) throw new Error(committed.error ?? "PART_COMMIT_FAILED");
                  committedBytes += part.sizeBytes;
                  inFlightProgress.delete(part.partNumber);
                  item.uploadedBytes = committedBytes + [...inFlightProgress.values()].reduce((sum, value) => sum + value, 0);
                } finally {
                  release();
                }
                return;
              } catch (error) {
                if (attempt >= 3 || signal.aborted) throw error;
                // A part that failed on a blip needs the link to settle before
                // the next attempt; retrying three times inside a second just
                // spends the budget without ever letting it recover.
                await sleep(500 * 2 ** (attempt - 1) * (0.5 + Math.random()));
              }
            }
          });
        }
        item.status = "verifying";
        this.notify(true);
        const complete = await apiPostResilient<{ sessionId: string; fileId: string; name: string; status: "ready" }>(`/api/uploads/${init.sessionId}/complete`, { parts: [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag })) });
        if (!complete.success) throw new Error(complete.error ?? "FINALIZATION_FAILED");
      }
      this.markDone(item);
      this.notify(true);
    } catch (error) {
      this.failItem(item, error instanceof Error ? error.message : "UPLOAD_FAILED");
      this.notify(true);
    } finally {
      this.abortSignals.delete(item.id);
    }
  }

  cancelItem(id: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    const signal = this.abortSignals.get(id);
    if (signal) {
      signal.aborted = true;
      signal.xhr?.abort();
      signal.xhrs.forEach((xhr) => xhr.abort());
    }
    if (item.sessionId) void apiPost(`/api/uploads/${item.sessionId}/abort`, {});
    item.status = "cancelled";
    this.notify(true);
  }

  retryItem(id: string) {
    const item = this.items.find((entry) => entry.id === id);
    if (!item || item.status !== "error") return;
    item.status = "queued";
    item.error = undefined;
    this.notify(true);
    void this.processNext();
  }

  retryFailed() {
    this.items.filter((item) => item.status === "error").forEach((item) => this.retryItem(item.id));
  }

  cancelAll() {
    this.items.filter((item) => item.status === "queued" || item.status === "uploading" || item.status === "verifying").forEach((item) => this.cancelItem(item.id));
  }

  pause() { if (!this.disposed) this.paused = true; }
  resume() { if (!this.disposed) { this.paused = false; void this.processNext(); } }

  clearCompleted() {
    const kept = this.items.filter((item) => item.status !== "done" && item.status !== "cancelled");
    const keptIds = new Set(kept.map((item) => item.id));
    for (const item of this.items) {
      if (!keptIds.has(item.id)) this.published.delete(item.id);
    }
    this.items = kept;
    this.notify(true);
  }

  getItems() { return this.disposed || this.scopeId !== getActivityScopeId() ? [] : [...this.items]; }
}

// One browser session must have one transfer engine. Keeping the queue at
// module scope means route changes do not detach active uploads from Activity.
let sharedUploadQueue: UploadQueue | null = null;

export function getSharedUploadQueue(): UploadQueue {
  const scopeId = getActivityScopeId();
  if (!sharedUploadQueue || sharedUploadQueue.getScopeId() !== scopeId) {
    sharedUploadQueue?.dispose();
    sharedUploadQueue = new UploadQueue(scopeId);
  }
  return sharedUploadQueue;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${Math.round(bytesPerSec)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

export function formatETA(seconds: number): string {
  if (seconds < 1) return "Almost done";
  if (seconds < 60) return `${Math.round(seconds)}s remaining`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s remaining`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m remaining`;
}

/**
 * Walk a dropped directory into the files it holds AND the directories it holds.
 *
 * Three things this fixes over the previous shape, all of which cost real content:
 *
 *  - Directories are reported. An empty folder has no file under it, so a tree
 *    rebuilt from file paths alone silently loses every empty directory — and a
 *    file explorer that drops folders is not a file explorer.
 *  - One unreadable entry no longer aborts the walk. `readEntries` and `file()`
 *    both reject on a file that vanished, is locked, or is a dangling symlink;
 *    a single one of those used to reject the whole traversal, so a 40,000-file
 *    project uploaded nothing at all. Failures are collected and reported.
 *  - Sibling directories are read concurrently. Serial recursion over a deep tree
 *    spent most of the scan waiting on the filesystem one `readEntries` at a time.
 */
export async function traverseDirectory(
  entry: FileSystemEntry,
  path = ""
): Promise<{ files: { file: File; relativePath: string }[]; directories: string[]; failed: string[] }> {
  const files: { file: File; relativePath: string }[] = [];
  const directories: string[] = [];
  const failed: string[] = [];

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const release = await fsAcquire();
    try {
      const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
      // `path` is this entry's OWN full path — the recursion below already appended
      // `child.name` before descending. Appending the filename a second time here
      // produced `src/index.ts/index.ts`, and since `collectFolderPaths` treats the
      // last segment as the filename, every file in a dropped tree was turned into a
      // FOLDER named after itself. That is precisely the "I opened it and there are
      // only folder names, no files" report: the files were uploaded, each one buried
      // in a directory wearing its own name.
      files.push({ file, relativePath: path || file.name });
    } catch {
      failed.push(path || entry.name);
    } finally {
      release();
    }
    return { files, directories, failed };
  }
  if (!entry.isDirectory) return { files, directories, failed };

  if (path) directories.push(path);

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  // `readEntries` returns at most 100 per call and signals the end with an empty
  // batch, so it has to be drained in a loop rather than called once.
  const children: FileSystemEntry[] = [];
  const release = await fsAcquire();
  try {
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
        reader.readEntries(resolve, reject)
      );
      if (batch.length === 0) break;
      children.push(...batch);
    }
  } catch {
    failed.push(path || entry.name);
  } finally {
    // Before the recursion, never after: a parent holding a slot while it waits on
    // its children is how this gate would deadlock on a tree deeper than the limit.
    release();
  }

  const results = await Promise.all(
    children.map((child) => traverseDirectory(child, path ? `${path}/${child.name}` : child.name))
  );
  for (const result of results) {
    files.push(...result.files);
    directories.push(...result.directories);
    failed.push(...result.failed);
  }

  return { files, directories, failed };
}

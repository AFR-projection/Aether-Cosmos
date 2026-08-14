"use client";

import { encryptFile, type EncryptionMetaV1 } from "@/lib/crypto/client-encryption";
import { markLocalUpload } from "@/lib/system/local-upload-registry";
import { syncTransferActivity, type ActivityStatus } from "@/lib/activity/activity-store";

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

const MAX_ACTIVE_FILES = 3;
const MAX_ACTIVE_TRANSFERS = 4;
const MAX_RETRIES = 3;
const API_BATCH_PARTS = 50;
const PROGRESS_THROTTLE_MS = 100;
const LARGE_ENCRYPTION_LIMIT = 64 * 1024 * 1024;

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

async function apiGet<T>(url: string): Promise<ApiResponse<T>> {
  const response = await fetch(url);
  return (await response.json()) as ApiResponse<T>;
}

class TransferLimiter {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  async acquire(): Promise<() => void> {
    if (this.active < MAX_ACTIVE_TRANSFERS) {
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

const transferLimiter = new TransferLimiter();

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
  private items: UploadItem[] = [];
  private listeners: Partial<UploadQueueEvents> = {};
  private processing = false;
  private paused = false;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private lastNotifyAt = 0;
  private speedSamples: number[] = [];
  private encryptEnabled = false;
  private encryptPassphrase: string | null = null;
  private abortSignals = new Map<string, { aborted: boolean; xhr?: XMLHttpRequest; xhrs: XMLHttpRequest[] }>();

  constructor() {
    void this.recoverActive();
  }

  setEncryption(enabled: boolean, passphrase: string | null) {
    this.encryptEnabled = enabled;
    this.encryptPassphrase = passphrase;
  }

  on<K extends keyof UploadQueueEvents>(event: K, cb: UploadQueueEvents[K]) {
    this.listeners[event] = cb;
  }

  off<K extends keyof UploadQueueEvents>(event: K) {
    delete this.listeners[event];
  }

  private emit(event: keyof UploadQueueEvents, ...args: unknown[]) {
    const cb = this.listeners[event] as ((...a: unknown[]) => void) | undefined;
    cb?.(...args);
  }

  private notify(immediate = false) {
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
        if (isActivityPopupPresentation() && item.status === "resume_requires_file") continue;
        const phase: ActivityStatus = item.status === "done" ? "completed" : item.status === "error" ? "failed" : item.status === "cancelled" ? "cancelled" : item.status === "resume_requires_file" ? "paused" : item.status;
        syncTransferActivity({ id: item.id, type: "upload", name: item.file?.name ?? item.remotePath, phase, loaded: item.uploadedBytes, total: item.totalBytes, speed: item.speed, error: item.error, fileId: item.fileId });
      }
      this.emit("change", [...this.items], this.getStats());
    }, delay);
  }

  getStats(): UploadStats {
    const total = this.items.length;
    const completed = this.items.filter((item) => item.status === "done").length;
    const failed = this.items.filter((item) => item.status === "error" || item.status === "resume_requires_file").length;
    const active = this.items.filter((item) => item.status === "preparing" || item.status === "uploading" || item.status === "verifying").length;
    const queued = this.items.filter((item) => item.status === "queued").length;
    const totalBytes = this.items.reduce((sum, item) => sum + item.totalBytes, 0);
    const loadedBytes = this.items.reduce((sum, item) => sum + Math.min(item.uploadedBytes, item.totalBytes), 0);
    const overallProgress = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
    const speed = this.currentSpeed();
    return { total, completed, failed, active, queued, totalBytes, loadedBytes, overallProgress, speed, eta: speed > 0 ? (totalBytes - loadedBytes) / speed : 0 };
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
    try {
      const response = await apiGet<{ uploads: UploadSession[] }>("/api/uploads/active");
      if (!response.success || !response.data) return;
      for (const upload of response.data.uploads) {
        if (this.items.some((item) => item.sessionId === upload.sessionId)) continue;
        this.items.push({ id: `recovered_${upload.sessionId}`, file: null, folderId: null, remotePath: upload.name, status: "resume_requires_file", progress: 0, uploadedBytes: upload.parts.filter((part) => part.status === "uploaded").reduce((sum, part) => sum + part.sizeBytes, 0), totalBytes: upload.totalSizeBytes, speed: 0, retries: upload.retryCount, error: "RESUME_REQUIRES_FILE", sessionId: upload.sessionId, fileId: upload.fileId, uploadId: upload.uploadId ?? undefined, mimeType: upload.mimeType });
      }
      this.notify(true);
    } catch {
      // Recovery is best effort; a normal newly selected file can still upload.
    }
  }

  private async processNext() {
    if (this.processing || this.paused) return;
    const queued = this.items.filter((item) => item.status === "queued");
    if (queued.length === 0) {
      if (this.getStats().active === 0 && this.items.length > 0) this.emit("allComplete");
      return;
    }
    this.processing = true;
    try {
      await mapPool(queued.slice(0, MAX_ACTIVE_FILES), MAX_ACTIVE_FILES, (item) => this.processItem(item));
    } finally {
      this.processing = false;
      if (!this.paused) void this.processNext();
    }
  }

  private async processItem(item: UploadItem) {
    if (!item.file || item.status === "cancelled") return;
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

      const initialized = await apiPost<InitResult>("/api/uploads/init", {
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
      item.uploadId = init.uploadId ?? undefined;
      item.totalBytes = init.totalSizeBytes;
      item.mimeType = uploadMime;

      if (init.status === "failed") {
        const retried = await apiPost<InitResult>(`/api/uploads/${init.sessionId}/retry`, {});
        if (!retried.success || !retried.data) throw new Error(retried.error ?? "UPLOAD_RETRY_FAILED");
        init = retried.data;
      }
      if (init.status === "completed") {
        item.uploadedBytes = item.totalBytes;
        item.progress = 100;
        item.status = "done";
        markLocalUpload(item.fileId);
        this.emit("complete", item);
        this.notify(true);
        return;
      }

      const stateResponse = await apiGet<UploadSession>(`/api/uploads/${init.sessionId}`);
      if (!stateResponse.success || !stateResponse.data) throw new Error(stateResponse.error ?? "UPLOAD_STATE_FAILED");
      const state = stateResponse.data;
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
        const complete = await apiPost<{ sessionId: string; fileId: string; name: string; status: "ready" }>(`/api/uploads/${init.sessionId}/complete`, {});
        if (!complete.success) throw new Error(complete.error ?? "FINALIZATION_FAILED");
      } else {
        if (!init.partSizeBytes || !init.partCount || !init.uploadId) throw new Error("MULTIPART_SESSION_INCOMPLETE");
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
          const signed = await apiPost<{ parts: { partNumber: number; sizeBytes: number; url: string }[] }>(`/api/uploads/${init.sessionId}/parts/sign`, { partNumbers });
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
                  const committed = await apiPost(`/api/uploads/${init.sessionId}/parts/commit`, { partNumber: part.partNumber, etag });
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
              }
            }
          });
        }
        item.status = "verifying";
        this.notify(true);
        const complete = await apiPost<{ sessionId: string; fileId: string; name: string; status: "ready" }>(`/api/uploads/${init.sessionId}/complete`, { parts: [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag })) });
        if (!complete.success) throw new Error(complete.error ?? "FINALIZATION_FAILED");
      }
      item.uploadedBytes = item.totalBytes;
      item.progress = 100;
      item.status = "done";
      markLocalUpload(item.fileId);
      this.emit("complete", item);
      this.notify(true);
    } catch (error) {
      if ((item.status as UploadItemStatus) === "cancelled") return;
      item.error = error instanceof Error ? error.message : "UPLOAD_FAILED";
      item.status = item.retries < MAX_RETRIES ? "queued" : "error";
      if (item.status === "queued") item.retries++;
      this.emit("error", item, item.error);
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

  pause() { this.paused = true; }
  resume() { this.paused = false; void this.processNext(); }

  clearCompleted() {
    this.items = this.items.filter((item) => item.status !== "done" && item.status !== "cancelled");
    this.notify(true);
  }

  getItems() { return [...this.items]; }
}

// One browser session must have one transfer engine. Keeping the queue at
// module scope means route changes do not detach active uploads from Activity.
let sharedUploadQueue: UploadQueue | null = null;

export function getSharedUploadQueue(): UploadQueue {
  if (!sharedUploadQueue) sharedUploadQueue = new UploadQueue();
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

export async function traverseDirectory(entry: FileSystemEntry, path = ""): Promise<{ file: File; relativePath: string }[]> {
  const results: { file: File; relativePath: string }[] = [];
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    results.push({ file, relativePath: path ? `${path}/${file.name}` : file.name });
    return results;
  }
  if (!entry.isDirectory) return results;
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const entries = await new Promise<FileSystemEntry[]>((resolve) => {
    const allEntries: FileSystemEntry[] = [];
    const readBatch = () => reader.readEntries((batch) => batch.length === 0 ? resolve(allEntries) : (allEntries.push(...batch), readBatch()));
    readBatch();
  });
  for (const child of entries) results.push(...await traverseDirectory(child, path ? `${path}/${child.name}` : child.name));
  return results;
}

"use client";

import { encryptFile, type EncryptionMetaV1 } from "@/lib/crypto/client-encryption";
import { markLocalUpload } from "@/lib/system/local-upload-registry";
import {
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_PARALLEL_PARTS,
} from "@/lib/storage/upload-constants";

export interface UploadItem {
  id: string;
  file: File;
  folderId: string | null;
  remotePath: string;
  status: "queued" | "uploading" | "done" | "error" | "cancelled";
  progress: number;
  speed: number;
  error?: string;
  fileId?: string;
  uploadId?: string;
  retries: number;
  encrypted?: boolean;
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

const MAX_CONCURRENT = 12;
const BATCH_SIZE = 50;
const MAX_RETRIES = 2;
const SPEED_SAMPLE_SIZE = 5;

type MultipartInfo = {
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
};

type PresignBatchItem = {
  clientId?: string;
  fileId: string;
  r2Key: string;
  uploadUrl?: string;
  multipart?: MultipartInfo;
};

let csrfToken: string | null = null;
async function getCsrf(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch("/api/auth/csrf");
  const json = await res.json();
  csrfToken = json.data.token;
  return csrfToken!;
}

async function apiPost<T>(
  url: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-csrf-token": await getCsrf() },
    body: JSON.stringify(body),
  });
  return res.json();
}

let counter = 0;
function uid(): string {
  return `up_${Date.now()}_${++counter}`;
}

async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

function putBlob(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
  signal?: { aborted: boolean; xhr?: XMLHttpRequest }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (signal) signal.xhr = xhr;
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`Upload failed (HTTP ${xhr.status})`));
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new Error("Cancelled")));
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.send(blob);
  });
}

function putPart(
  url: string,
  blob: Blob,
  signal?: { aborted: boolean; xhrs: XMLHttpRequest[] }
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    signal?.xhrs.push(xhr);
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag");
        if (!etag) {
          reject(new Error("Missing ETag from part upload"));
          return;
        }
        resolve(etag);
      } else {
        reject(new Error(`Part upload failed (HTTP ${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("Network error")));
    xhr.addEventListener("abort", () => reject(new Error("Cancelled")));
    xhr.open("PUT", url);
    xhr.send(blob);
  });
}

export class UploadQueue {
  private items: UploadItem[] = [];
  private listeners: Partial<UploadQueueEvents> = {};
  private processing = false;
  private paused = false;
  private speedSamples: number[] = [];
  private encryptEnabled = false;
  private encryptPassphrase: string | null = null;
  private abortSignals = new Map<
    string,
    { aborted: boolean; xhr?: XMLHttpRequest; xhrs: XMLHttpRequest[] }
  >();

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
    if (cb) cb(...args);
  }

  private notify() {
    this.emit("change", this.items, this.getStats());
  }

  getStats(): UploadStats {
    const total = this.items.length;
    const completed = this.items.filter((i) => i.status === "done").length;
    const failed = this.items.filter((i) => i.status === "error").length;
    const active = this.items.filter((i) => i.status === "uploading").length;
    const queued = this.items.filter((i) => i.status === "queued").length;
    const totalBytes = this.items.reduce((s, i) => s + i.file.size, 0);
    const loadedBytes = this.items.reduce((s, i) => s + (i.file.size * i.progress) / 100, 0);
    const overallProgress = totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0;
    const speed = this.getCurrentSpeed();
    const remainingBytes = totalBytes - loadedBytes;
    const eta = speed > 0 ? remainingBytes / speed : 0;
    return { total, completed, failed, active, queued, totalBytes, loadedBytes, overallProgress, speed, eta };
  }

  private getCurrentSpeed(): number {
    if (this.speedSamples.length === 0) return 0;
    const sum = this.speedSamples.reduce((a, b) => a + b, 0);
    return sum / this.speedSamples.length;
  }

  private trackSpeed(bytesPerSec: number) {
    this.speedSamples.push(bytesPerSec);
    if (this.speedSamples.length > SPEED_SAMPLE_SIZE) this.speedSamples.shift();
  }

  addFiles(files: File[], baseFolderId: string | null = null, pathPrefix: string = "") {
    for (const file of files) {
      const remotePath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
      this.items.push({
        id: uid(),
        file,
        folderId: baseFolderId,
        remotePath,
        status: "queued",
        progress: 0,
        speed: 0,
        retries: 0,
        encrypted: this.encryptEnabled,
      });
    }
    this.notify();
    void this.processNext();
  }

  addFolderStructure(entries: { file: File; relativePath: string; folderId: string | null }[]) {
    for (const entry of entries) {
      this.items.push({
        id: uid(),
        file: entry.file,
        folderId: entry.folderId,
        remotePath: entry.relativePath,
        status: "queued",
        progress: 0,
        speed: 0,
        retries: 0,
        encrypted: this.encryptEnabled,
      });
    }
    this.notify();
    void this.processNext();
  }

  private async processNext() {
    if (this.paused || this.processing) return;

    const queued = this.items.filter((i) => i.status === "queued");
    if (queued.length === 0) {
      const stats = this.getStats();
      if (stats.active === 0) this.emit("allComplete");
      return;
    }

    queued.sort((a, b) => a.file.size - b.file.size);
    const batch = queued.slice(0, BATCH_SIZE);
    for (const item of batch) item.status = "uploading";
    this.processing = true;
    this.notify();

    try {
      await this.uploadBatch(batch);
    } finally {
      this.processing = false;
      if (!this.paused) void this.processNext();
    }
  }

  private async uploadBatch(batch: UploadItem[]) {
    type Prepared = {
      item: UploadItem;
      uploadBlob: Blob;
      uploadSize: number;
      uploadMime: string;
      encryptionMeta?: EncryptionMetaV1;
      shouldEncrypt: boolean;
    };

    const prepared: Prepared[] = [];

    for (const item of batch) {
      if (item.status === "cancelled") continue;
      try {
        const shouldEncrypt = !!(item.encrypted && this.encryptPassphrase);
        let uploadBlob: Blob = item.file;
        let uploadSize = item.file.size;
        let uploadMime = item.file.type || "application/octet-stream";
        let encryptionMeta: EncryptionMetaV1 | undefined;

        if (shouldEncrypt) {
          const encrypted = await encryptFile(item.file, this.encryptPassphrase!);
          uploadBlob = encrypted.blob;
          uploadSize = encrypted.sizeBytes;
          uploadMime = "application/octet-stream";
          encryptionMeta = encrypted.meta;
        }

        prepared.push({ item, uploadBlob, uploadSize, uploadMime, encryptionMeta, shouldEncrypt });
      } catch (err) {
        this.failOrRetry(item, err);
      }
    }

    if (prepared.length === 0) return;

    const presign = await apiPost<{ uploads: PresignBatchItem[] }>("/api/upload/presign-batch", {
      files: prepared.map((p) => ({
        clientId: p.item.id,
        filename: p.item.file.name,
        mimeType: p.item.file.type || "application/octet-stream",
        sizeBytes: p.uploadSize,
        folderId: p.item.folderId,
        encrypted: p.shouldEncrypt,
        encryptionMeta: p.encryptionMeta,
      })),
    });

    if (!presign.success || !presign.data?.uploads) {
      const err = new Error(presign.error ?? "Failed to prepare batch upload");
      for (const p of prepared) this.failOrRetry(p.item, err);
      return;
    }

    const byClient = new Map(
     presign.data.uploads.map((u) => [u.clientId ?? u.fileId, u])
    );

    const completePayload: {
      fileId: string;
      encrypted?: boolean;
      encryptionMeta?: EncryptionMetaV1;
      originalMimeType?: string;
      multipart?: { uploadId: string; parts: { partNumber: number; etag: string }[] };
    }[] = [];

    await mapPool(prepared, MAX_CONCURRENT, async (p) => {
      const item = p.item;
      if (item.status === "cancelled") return;

      const meta = byClient.get(item.id);
      if (!meta) {
        this.failOrRetry(item, new Error("Missing presign for file"));
        return;
      }

      item.fileId = meta.fileId;
      item.uploadId = meta.multipart?.uploadId;
      const signal = { aborted: false, xhrs: [] as XMLHttpRequest[] };
      this.abortSignals.set(item.id, signal);

      try {
        let multipartParts: { partNumber: number; etag: string }[] | undefined;

        if (meta.multipart) {
          multipartParts = await this.uploadMultipart(item, p.uploadBlob, meta.multipart, signal);
        } else if (meta.uploadUrl) {
          let lastLoaded = 0;
          let lastTime = Date.now();
          await putBlob(
            meta.uploadUrl,
            p.uploadBlob,
            p.uploadMime,
            (loaded, total) => {
              item.progress = Math.round((loaded / total) * 100);
              const now = Date.now();
              const dt = (now - lastTime) / 1000;
              if (dt > 0.3) {
                const bps = (loaded - lastLoaded) / dt;
                item.speed = bps;
                this.trackSpeed(bps);
                lastLoaded = loaded;
                lastTime = now;
              }
              this.notify();
            },
            signal
          );
        } else {
          throw new Error("No upload URL returned");
        }

        item.progress = 100;
        this.notify();

        completePayload.push({
          fileId: meta.fileId,
          encrypted: p.shouldEncrypt,
          encryptionMeta: p.encryptionMeta,
          originalMimeType: p.shouldEncrypt
            ? p.item.file.type || "application/octet-stream"
            : undefined,
          multipart: multipartParts
            ? { uploadId: meta.multipart!.uploadId, parts: multipartParts }
            : undefined,
        });
      } catch (err) {
        if ((item.status as UploadItem["status"]) === "cancelled") return;
        this.failOrRetry(item, err);
      } finally {
        this.abortSignals.delete(item.id);
      }
    });

    if (completePayload.length === 0) return;

    // complete in chunks of 50
    for (let i = 0; i < completePayload.length; i += BATCH_SIZE) {
      const chunk = completePayload.slice(i, i + BATCH_SIZE);
      const complete = await apiPost<{
        completed: { fileId: string; name: string }[];
        failed: { fileId: string; error: string }[];
      }>("/api/upload/complete-batch", { files: chunk });

      const okIds = new Set((complete.data?.completed ?? []).map((c) => c.fileId));
      const failMap = new Map((complete.data?.failed ?? []).map((f) => [f.fileId, f.error]));

      for (const entry of chunk) {
        const item = this.items.find((it) => it.fileId === entry.fileId);
        if (!item || item.status === "cancelled") continue;

        if (!complete.success) {
          this.failOrRetry(item, new Error(complete.error ?? "Complete failed"));
          continue;
        }

        if (okIds.has(entry.fileId)) {
          item.status = "done";
          item.progress = 100;
          // Mark so the realtime SSE toast for this file is suppressed (the
          // upload panel shows a batch summary instead — no double toast).
          markLocalUpload(item.fileId);
          this.emit("complete", item);
        } else {
          this.failOrRetry(item, new Error(failMap.get(entry.fileId) ?? "Complete failed"));
        }
      }
      this.notify();
    }
  }

  private async uploadMultipart(
    item: UploadItem,
    blob: Blob,
    multipart: MultipartInfo,
    signal: { aborted: boolean; xhrs: XMLHttpRequest[] }
  ): Promise<{ partNumber: number; etag: string }[]> {
    const partSize = multipart.partSize || MULTIPART_PART_SIZE_BYTES;
    const results: { partNumber: number; etag: string }[] = [];
    let uploadedBytes = 0;
    const total = blob.size;
    let lastTime = Date.now();
    let lastBytes = 0;

    await mapPool(multipart.parts, MULTIPART_PARALLEL_PARTS, async (part) => {
      if (signal.aborted || item.status === "cancelled") throw new Error("Cancelled");
      const start = (part.partNumber - 1) * partSize;
      const end = Math.min(start + partSize, total);
      const slice = blob.slice(start, end);

      let etag: string | null = null;
      let attempt = 0;
      while (attempt < 3 && !etag) {
        try {
          etag = await putPart(part.url, slice, signal);
        } catch (err) {
          attempt++;
          if (attempt >= 3) throw err;
        }
      }

      results.push({ partNumber: part.partNumber, etag: etag! });
      uploadedBytes += end - start;
      item.progress = Math.min(99, Math.round((uploadedBytes / total) * 100));

      const now = Date.now();
      const dt = (now - lastTime) / 1000;
      if (dt > 0.3) {
        const bps = (uploadedBytes - lastBytes) / dt;
        item.speed = bps;
        this.trackSpeed(bps);
        lastBytes = uploadedBytes;
        lastTime = now;
      }
      this.notify();
    });

    return results.sort((a, b) => a.partNumber - b.partNumber);
  }

  private failOrRetry(item: UploadItem, err: unknown) {
    if (item.status === "cancelled") return;

    if (item.retries < MAX_RETRIES) {
      item.retries++;
      item.status = "queued";
      item.progress = 0;
      item.fileId = undefined;
      item.uploadId = undefined;
      this.notify();
      return;
    }

    item.status = "error";
    item.error = err instanceof Error ? err.message : "Upload failed";
    this.emit("error", item, item.error);
    this.notify();
  }

  cancelItem(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (item.status === "uploading") {
      const signal = this.abortSignals.get(id);
      if (signal) {
        signal.aborted = true;
        signal.xhr?.abort();
        for (const xhr of signal.xhrs) xhr.abort();
      }
      if (item.fileId) {
        apiPost("/api/upload/cancel", {
          fileId: item.fileId,
          multipart: item.uploadId ? { uploadId: item.uploadId } : undefined,
        }).catch(() => {});
      }
    }
    item.status = "cancelled";
    this.notify();
  }

  cancelAll() {
    for (const item of this.items) {
      if (item.status === "queued" || item.status === "uploading") {
        this.cancelItem(item.id);
      }
    }
  }

  retryItem(id: string) {
    const item = this.items.find((i) => i.id === id);
    if (!item || item.status !== "error") return;
    item.status = "queued";
    item.progress = 0;
    item.error = undefined;
    item.retries = 0;
    item.fileId = undefined;
    item.uploadId = undefined;
    this.notify();
    void this.processNext();
  }

  retryFailed() {
    for (const item of this.items) {
      if (item.status === "error") {
        this.retryItem(item.id);
      }
    }
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    void this.processNext();
  }

  clearCompleted() {
    this.items = this.items.filter((i) => i.status !== "done" && i.status !== "cancelled");
    this.notify();
  }

  getItems(): UploadItem[] {
    return [...this.items];
  }
}

// Re-export threshold for callers that need to know
export { MULTIPART_THRESHOLD_BYTES } from "@/lib/storage/upload-constants";

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

export async function traverseDirectory(
  entry: FileSystemEntry,
  path: string = ""
): Promise<{ file: File; relativePath: string }[]> {
  const results: { file: File; relativePath: string }[] = [];

  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => fileEntry.file(resolve, reject));
    results.push({ file, relativePath: path ? `${path}/${file.name}` : file.name });
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const reader = dirEntry.createReader();
    const entries = await new Promise<FileSystemEntry[]>((resolve) => {
      const allEntries: FileSystemEntry[] = [];
      function readBatch() {
        reader.readEntries((batch) => {
          if (batch.length === 0) {
            resolve(allEntries);
          } else {
            allEntries.push(...batch);
            readBatch();
          }
        });
      }
      readBatch();
    });

    for (const child of entries) {
      const childPath = path ? `${path}/${child.name}` : child.name;
      const childResults = await traverseDirectory(child, childPath);
      results.push(...childResults);
    }
  }

  return results;
}

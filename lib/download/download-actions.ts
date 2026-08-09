"use client";

import { getCsrfToken } from "@/lib/api/client";
import { decryptToBlob, isEncryptionMeta, type EncryptionMetaV1 } from "@/lib/crypto/client-encryption";
import { startDownload, finishDownload, failDownload, updateDownloadProgress } from "./download-store";
import { setPendingEncryptedDownload } from "./encrypted-download-store";

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type DownloadableFile = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes?: number | null;
  encrypted?: boolean | null;
  encryptionMeta?: unknown;
};

export function requestDownload(file: DownloadableFile) {
  if (file.encrypted) {
    if (!isEncryptionMeta(file.encryptionMeta)) {
      const id = startDownload(file.name);
      failDownload(id, "File terenkripsi tapi metadata enkripsi tidak ada");
      return;
    }
    setPendingEncryptedDownload({ fileId: file.id, fileName: file.name, mimeType: file.mimeType, meta: file.encryptionMeta as EncryptionMetaV1 });
    return;
  }
  // The API authenticates and returns a short-lived R2 URL. The browser then
  // transfers the bytes directly, including for multi-GB objects.
  downloadFile(file.id, file.name);
}

export async function saveDecryptedFile(
  fileId: string,
  fileName: string,
  mimeType: string,
  meta: EncryptionMetaV1,
  passphrase: string
) {
  const response = await fetch(`/api/files/${fileId}/preview`);
  if (!response.ok) throw new Error("Gagal mengambil file terenkripsi");
  const plaintext = await decryptToBlob(await response.arrayBuffer(), passphrase, meta, mimeType);
  const id = startDownload(fileName);
  try {
    saveBlob(plaintext, fileName);
    finishDownload(id);
  } catch (error) {
    failDownload(id, error instanceof Error ? error.message : "Gagal menyimpan file");
    throw error;
  }
}

export function downloadViewerSource(src: string, fileId: string, fileName: string) {
  if (src.startsWith("blob:")) {
    const id = startDownload(fileName);
    try {
      const anchor = document.createElement("a");
      anchor.href = src;
      anchor.download = fileName;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      finishDownload(id);
    } catch (error) {
      failDownload(id, error instanceof Error ? error.message : "Gagal menyimpan file");
    }
    return;
  }
  downloadFile(fileId, fileName);
}

export function downloadFile(fileId: string, fileName: string) {
  const id = startDownload(fileName);
  try {
    const anchor = document.createElement("a");
    anchor.href = `/api/download/${fileId}`;
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // Browser navigation owns the transfer; JavaScript cannot observe the R2
    // response without buffering it. Keep the manager bounded and honest.
    setTimeout(() => finishDownload(id), 800);
  } catch (error) {
    failDownload(id, error instanceof Error ? error.message : "Failed to start download");
  }
}

/** Compatibility API. It intentionally delegates to direct R2 navigation. */
export async function downloadFileWithProgress(fileId: string, fileName: string, _maxRetries = 3) {
  downloadFile(fileId, fileName);
}

export async function downloadZip(ids: string[], label = "download.zip") {
  if (ids.length === 0) return;
  const id = startDownload(label);
  try {
    const response = await fetch("/api/download/zip", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": await getCsrfToken() },
      body: JSON.stringify({ ids }),
    });
    if (!response.ok) {
      const json = await response.json().catch(() => null) as { error?: string } | null;
      failDownload(id, json?.error ?? `ZIP failed (${response.status})`);
      return;
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    const blob = await readStreamWithProgress(id, response, total);
    saveBlob(blob, label);
    finishDownload(id);
  } catch (error) {
    failDownload(id, error instanceof Error ? error.message : "ZIP download failed");
  }
}

/** Queue a large folder archive and download the verified R2 result directly. */
export async function requestFolderArchive(folderId: string, folderName: string) {
  const label = `${folderName}.zip`;
  const downloadId = startDownload(label);
  const idempotencyKey = crypto.randomUUID();
  try {
    const response = await fetch(`/api/folders/${folderId}/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-csrf-token": await getCsrfToken() },
      body: JSON.stringify({ idempotencyKey, archiveName: folderName }),
    });
    const json = await response.json().catch(() => null) as {
      data?: { job?: ArchiveJobClient; downloadUrl?: string };
      error?: string;
    } | null;
    if (!response.ok || !json?.data?.job) {
      failDownload(downloadId, json?.error ?? `Archive failed (${response.status})`);
      return;
    }

    let job = json.data.job;
    let lastBytes = 0;
    let lastAt = performance.now();
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (job.status === "ready") {
        const url = json.data.downloadUrl ?? (await getArchiveStatus(job.id)).downloadUrl;
        if (!url) throw new Error("Archive URL belum tersedia");
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = job.archiveName;
        anchor.rel = "noopener";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        finishDownload(downloadId);
        return;
      }
      if (job.status === "failed" || job.status === "expired") {
        throw new Error(job.errorMessage ?? "Archive gagal diproses");
      }

      const now = performance.now();
      const seconds = (now - lastAt) / 1000;
      if (seconds > 0) updateDownloadProgress(downloadId, job.processedBytes, job.totalBytes, (job.processedBytes - lastBytes) / seconds);
      lastBytes = job.processedBytes;
      lastAt = now;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const status = await getArchiveStatus(job.id);
      job = status.job;
      if (status.downloadUrl) {
        // Keep the URL in the same polling result so the ready branch does not
        // issue a second request or generate another signed URL.
        json.data.downloadUrl = status.downloadUrl;
      }
    }
    throw new Error("Archive terlalu lama diproses, silakan cek lagi nanti");
  } catch (error) {
    failDownload(downloadId, error instanceof Error ? error.message : "Archive download failed");
  }
}

type ArchiveJobClient = {
  id: string;
  status: "created" | "processing" | "ready" | "failed" | "expired";
  archiveName: string;
  processedBytes: number;
  totalBytes: number;
  errorMessage?: string | null;
};

async function getArchiveStatus(id: string): Promise<{ job: ArchiveJobClient; downloadUrl?: string }> {
  const response = await fetch(`/api/download/archive/${id}`);
  const json = await response.json().catch(() => null) as {
    data?: { job?: ArchiveJobClient; downloadUrl?: string };
    error?: string;
  } | null;
  if (!response.ok || !json?.data?.job) throw new Error(json?.error ?? `Archive status failed (${response.status})`);
  return { job: json.data.job, downloadUrl: json.data.downloadUrl };
}

async function readStreamWithProgress(id: string, response: Response, total: number): Promise<Blob> {
  if (!response.body) return response.blob();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastTime = performance.now();
  let lastLoaded = 0;
  let speed = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    loaded += value.byteLength;
    const now = performance.now();
    const elapsed = (now - lastTime) / 1000;
    if (elapsed >= 0.25) {
      const instant = (loaded - lastLoaded) / elapsed;
      speed = speed === 0 ? instant : speed * 0.7 + instant * 0.3;
      lastTime = now;
      lastLoaded = loaded;
      updateDownloadProgress(id, loaded, total, speed);
    }
  }
  updateDownloadProgress(id, loaded, total || loaded, speed);
  return new Blob(chunks as BlobPart[]);
}

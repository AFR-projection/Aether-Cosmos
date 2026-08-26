"use client";

import { storeSecurityAlert } from "@/components/auth/security-alert";

let csrfToken: string | null = null;

export function resetCsrfToken(): void {
  csrfToken = null;
}

export async function getCsrfToken(): Promise<string> {
  if (csrfToken) return csrfToken;
  const res = await fetch("/api/auth/csrf");
  const json = await res.json();
  csrfToken = json.data.token;
  return csrfToken!;
}

type ApiResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  previousIp?: string;
  currentIp?: string;
};

function handleAuthSecurityCodes(json: ApiResult<unknown>, status: number) {
  if (status !== 401) return;
  const code = json.code;
  if (code !== "SESSION_IP_CHANGED" && code !== "SESSION_INACTIVE") return;

  storeSecurityAlert({
    code,
    message: json.error,
    previousIp: json.previousIp,
    currentIp: json.currentIp,
  });

  if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    const params = new URLSearchParams({ alert: code });
    if (json.previousIp) params.set("previousIp", json.previousIp);
    if (json.currentIp) params.set("currentIp", json.currentIp);
    window.location.href = `/login?${params.toString()}`;
  }
}

export async function apiFetch<T>(
  url: string,
  options: RequestInit = {}
): Promise<ApiResult<T>> {
  const method = options.method?.toUpperCase() ?? "GET";
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  if (method !== "GET" && method !== "HEAD") {
    headers["x-csrf-token"] = await getCsrfToken();
    if (!headers["Content-Type"] && options.body && typeof options.body === "string") {
      headers["Content-Type"] = "application/json";
    }
  }

  const res = await fetch(url, { ...options, headers });
  const json = (await res.json()) as ApiResult<T>;
  handleAuthSecurityCodes(json, res.status);
  return json;
}

async function cancelPendingUpload(fileId: string) {
  try {
    await apiFetch("/api/upload/cancel", {
      method: "POST",
      body: JSON.stringify({ fileId }),
    });
  } catch {
    // ignore cleanup errors
  }
}

export async function uploadFile(
  file: File,
  folderId?: string | null,
  onProgress?: (pct: number) => void
): Promise<{ fileId: string; name: string }> {
  const presign = await apiFetch<{ fileId: string; uploadUrl: string }>("/api/upload/presign", {
    method: "POST",
    body: JSON.stringify({
      filename: file.name,
      mimeType: file.type || "application/octet-stream",
      sizeBytes: file.size,
      folderId,
    }),
  });

  if (!presign.success || !presign.data) {
    throw new Error(presign.error ?? "Couldn't prepare the upload");
  }

  const { fileId, uploadUrl } = presign.data;

  try {
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload to storage failed (HTTP ${xhr.status})`));
        }
      });
      xhr.addEventListener("error", () => {
        reject(
          new Error(
            "Upload to R2 failed. Check that the R2 bucket's CORS rules are configured (see docker/r2-cors.json)."
          )
        );
      });
      xhr.addEventListener("abort", () => reject(new Error("Upload cancelled")));
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      xhr.send(file);
    });
  } catch (error) {
    await cancelPendingUpload(fileId);
    throw error;
  }

  const complete = await apiFetch<{ fileId: string; name: string }>("/api/upload/complete", {
    method: "POST",
    body: JSON.stringify({ fileId }),
  });

  if (!complete.success || !complete.data) {
    await cancelPendingUpload(fileId);
    throw new Error(complete.error ?? "The upload couldn't be completed");
  }

  return complete.data;
}

export async function getPreviewUrl(fileId: string): Promise<string | null> {
  const res = await apiFetch<{ url: string }>(`/api/files/${fileId}/preview?format=json`);
  if (!res.success || !res.data?.url) return null;
  return res.data.url;
}

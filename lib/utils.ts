import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function formatDate(date: Date | string, variant?: "short" | "medium"): string {
  if (variant === "short") {
    return new Intl.DateTimeFormat("id-ID", {
      dateStyle: "short",
    }).format(new Date(date));
  }
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
}

/** Clock time only. Used where the surrounding UI already states the day. */
export function formatTime(date: Date | string): string {
  return new Intl.DateTimeFormat("id-ID", { timeStyle: "short" }).format(new Date(date));
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 255);
}

export function getFileExtension(name: string): string {
  const parts = name.split(".");
  return parts.length > 1 ? (parts.pop()?.toLowerCase() ?? "") : "";
}

export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escapes the LIKE/ILIKE wildcards (% and _) plus the escape character itself, so
 * user input is matched literally. Pair the query with an ESCAPE clause.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function getMimeCategory(mimeType: string): string {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.includes("word") || mimeType.includes("document")) return "document";
  if (mimeType.includes("sheet") || mimeType.includes("excel")) return "spreadsheet";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) return "presentation";
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("archive"))
    return "archive";
  if (mimeType.startsWith("text/") || mimeType.includes("markdown")) return "text";
  return "other";
}

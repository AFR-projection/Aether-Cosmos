/**
 * Build the filename part of a `Content-Disposition` header safely.
 *
 * Emits both a sanitized ASCII `filename` (broad compatibility) and an RFC 5987
 * `filename*` (UTF-8, for names with accents, emoji, or non-Latin scripts).
 *
 * It lives in `src/shared` because two features hand filenames to R2 now — files
 * and backups — and the layer rules stop the second importing the first. The Files
 * feature re-exports it so its own call sites and tests keep their import path.
 */
export function encodeContentDispositionFilename(name: string): string {
  // ASCII fallback: replace path separators, quotes, and any control or
  // non-ASCII char with underscore so the quoted filename stays valid. A raw
  // CR or LF here would be header injection, which is why the control range is
  // stripped before anything else is considered.
  const ascii = name
    .replace(/[/\\]/g, "_")
    .replace(/[\x00-\x1f"]/g, "_")
    .replace(/[^\x20-\x7e]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

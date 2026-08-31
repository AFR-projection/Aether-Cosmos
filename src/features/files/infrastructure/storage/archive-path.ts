/**
 * Entry names for server-built ZIP archives.
 *
 * A file's name is whatever the uploader typed — `filename` is validated only for
 * length (1–255 chars), so it can contain `/`, `\`, `..` or control characters.
 * When such a name is written into a ZIP entry verbatim, the archive we hand back
 * is a zip-slip payload: an extractor that trusts entry paths writes outside the
 * directory the recipient chose. In a shared folder the uploader and the person
 * downloading the ZIP are not the same person, so the name is genuinely untrusted
 * input on that path.
 *
 * `POST /api/folders/[id]/download` already sanitized its paths; `POST /api/download/zip`
 * did not, and the two had separate copies of the logic. One implementation, used
 * by both.
 */

/** One path segment: no separators, no traversal, no control characters. */
export function archiveSegment(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const unsafe = char === "/" || char === "\\" || code < 0x20 || code === 0x7f;
    cleaned += unsafe ? "_" : char;
  }
  cleaned = cleaned.trim();
  return cleaned === "." || cleaned === ".." || cleaned.length === 0 ? "_" : cleaned;
}

/** The download filename of the archive itself, always ending in `.zip`. */
export function archiveFileName(value: string): string {
  const base = archiveSegment(value).replace(/\.zip$/i, "");
  return `${base || "archive"}.zip`;
}

/**
 * Make a path unique within one archive by suffixing ` (n)` before the extension.
 * Works for a bare filename as well as a nested path.
 */
export function uniqueArchivePath(path: string, used: Map<string, number>): string {
  const count = used.get(path) ?? 0;
  used.set(path, count + 1);
  if (count === 0) return path;

  const slash = path.lastIndexOf("/");
  const parent = slash >= 0 ? path.slice(0, slash + 1) : "";
  const name = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = name.lastIndexOf(".");
  const renamed =
    dot > 0 ? `${name.slice(0, dot)} (${count})${name.slice(dot)}` : `${name} (${count})`;
  return `${parent}${renamed}`;
}

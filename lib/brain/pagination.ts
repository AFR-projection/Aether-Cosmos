/**
 * Keyset ("seek") pagination for memory lists.
 *
 * The cursor carries BOTH createdAt and id because created_at is not unique: two
 * memories written in the same millisecond would otherwise be silently skipped
 * or returned twice. The list query compares the (created_at, id) tuple, which
 * is exactly the order of `memories_brain_keyset_idx`.
 *
 * decode() returns null for anything malformed instead of throwing — a hand-typed
 * `?cursor=abc` must be a 400, never a 500 from `new Date("abc")`.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MemoryCursor = { createdAt: Date; id: string };

export function encodeMemoryCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

export function decodeMemoryCursor(raw: string): MemoryCursor | null {
  if (!raw || raw.length > 200) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }

  const separator = decoded.indexOf("|");
  if (separator <= 0) return null;

  const isoPart = decoded.slice(0, separator);
  const idPart = decoded.slice(separator + 1);
  if (!UUID_RE.test(idPart)) return null;

  const createdAt = new Date(isoPart);
  if (Number.isNaN(createdAt.getTime())) return null;

  return { createdAt, id: idPart };
}

/**
 * Clamps a caller-supplied page size. NaN/absent/negative all fall back to the
 * default rather than reaching SQL as `LIMIT NaN`.
 */
export function clampLimit(value: unknown, fallback: number, max: number): number {
  // null/undefined/"" mean "not supplied" — Number() turns them into 0, which
  // would silently clamp to a 1-row page instead of using the default.
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") return fallback;

  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

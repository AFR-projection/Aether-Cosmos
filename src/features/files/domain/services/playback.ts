/**
 * What may be played straight from R2, for how long, and when the URL has to be replaced.
 *
 * All of it is pure, and it is here rather than in the route because three surfaces have to
 * agree: the authenticated playback endpoint, the share playback endpoint, and the player
 * that decides when to ask for a fresh URL. A disagreement between them is not a visible
 * bug — it is a video that stops halfway through, once, on long films only.
 *
 * The shape of the fix this belongs to: authorization is a CONTROL PLANE request that happens
 * once, and the bytes are a DATA PLANE conversation between the browser and R2 that the app
 * never sees. Everything below exists to make that single authorization last exactly as long
 * as it should and no longer.
 */

/** Why a playback URL was refused. Each maps to one status and one sentence. */
export type PlaybackRefusalReason =
  "not-ready" | "no-object" | "note" | "encrypted" | "unsupported";

export type PlaybackEligibility =
  { ok: true } | { ok: false; reason: PlaybackRefusalReason };

/**
 * `encrypted` is 409 rather than 4xx-final on purpose: the file is fine and the caller is
 * allowed to see it, but its bytes are ciphertext and only the browser holds the passphrase.
 * The client reads this as "use the decryption path", not as an error.
 */
export const PLAYBACK_REFUSAL_STATUS: Record<PlaybackRefusalReason, number> = {
  "not-ready": 409,
  "no-object": 404,
  note: 400,
  encrypted: 409,
  unsupported: 415,
};

/** Statuses whose object is present in R2. Mirrors `resolveFileAccess`'s own filter. */
const PLAYABLE_STATUSES = new Set(["ready", "legacy_unverified"]);

export type PlaybackCandidate = {
  mimeType: string;
  sizeBytes: number;
  r2Key: string;
  status: string;
  isNote: boolean;
  encrypted: boolean;
};

/** `video/mp4; codecs=avc1` and `VIDEO/MP4` are the same type as far as routing goes. */
export function isPlayableVideoMime(mimeType: string): boolean {
  return mimeType.trim().toLowerCase().split(";")[0].startsWith("video/");
}

export function playbackEligibility(
  file: PlaybackCandidate,
): PlaybackEligibility {
  if (file.isNote || file.r2Key.startsWith("notes/"))
    return { ok: false, reason: "note" };
  if (!PLAYABLE_STATUSES.has(file.status))
    return { ok: false, reason: "not-ready" };
  if (!file.r2Key || file.r2Key === "pending")
    return { ok: false, reason: "no-object" };
  if (file.sizeBytes <= 0) return { ok: false, reason: "no-object" };
  // Checked before the MIME test so an encrypted video gets the routing answer, not a
  // format complaint — the ciphertext's declared type is still `video/mp4`.
  if (file.encrypted) return { ok: false, reason: "encrypted" };
  if (!isPlayableVideoMime(file.mimeType))
    return { ok: false, reason: "unsupported" };
  return { ok: true };
}

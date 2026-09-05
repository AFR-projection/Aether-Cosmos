/**
 * Bounds for subtitle generation.
 *
 * Two of these ceilings exist because the work is done by somebody else and billed by the
 * minute, which makes them different in kind from the ones in `../edit-limits.ts`: an image
 * edit that is too big costs memory this process has, while a transcription that is too long
 * costs money the operator has. So the duration ceiling is a spend limit, and the per-user
 * quota beside it is what stops one account spending the whole instance's budget.
 *
 * The source-size ceiling is deliberately NOT a new number — see {@link SUBTITLE_SOURCE_MAX_BYTES}.
 */

import { EXTRACT_AUDIO_SOURCE_MAX_BYTES } from "../edit-limits";

/**
 * Largest video whose audio a job will pull out of storage.
 *
 * Reuses the extract-audio ceiling because it bounds exactly the same thing for exactly the same
 * reason: the worker streams the source to a temporary file, so this is a limit on disk and on
 * how long one job may hold a worker slot — not on heap. Two numbers for one constraint would
 * drift apart.
 */
export const SUBTITLE_SOURCE_MAX_BYTES = EXTRACT_AUDIO_SOURCE_MAX_BYTES;

/**
 * Longest media a single job will transcribe.
 *
 * Six hours covers any film, a long lecture, and a recorded stream. Past that it is far more
 * likely to be a mistake — a concatenated archive, a stuck recording — and the cost of finding
 * out is a real bill.
 */
export const SUBTITLE_MAX_DURATION_SECONDS = 6 * 60 * 60;

/** Largest `.srt`/`.vtt` a user may attach. A three-hour film's subtitles are well under 200 KB. */
export const SUBTITLE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Most cues one track may hold.
 *
 * A six-hour film at the tightest plausible cue density is around 12,000 lines, so this is
 * headroom rather than a limit anybody meets — it is here to bound what a hostile upload can
 * insert in one request.
 */
export const SUBTITLE_MAX_CUES = 20_000;

/** Target languages one request may ask for at once. Each one is a separate paid translation. */
export const SUBTITLE_MAX_TARGETS = 5;

/**
 * Transcription minutes a user gets per rolling 30 days, as seconds.
 *
 * Ten hours is roughly five films a month — generous for a personal account and small enough
 * that a runaway loop costs cents rather than a rent payment. A master can raise or clear it per
 * user; `0` means unlimited, matching how `bandwidth_quota_bytes` reads.
 */
export const DEFAULT_SUBTITLE_QUOTA_SECONDS = 10 * 60 * 60;

/**
 * Subtitle limits separate product eligibility from bounded operations.
 *
 * There is intentionally no generated-media duration, source-byte, cue-count, target-count, or
 * per-user quota constant here. Durable pipeline runs can cover any finite source by repeatedly
 * scheduling bounded work. The remaining limits protect one upload/request/response or one worker
 * operation, and overflow must be rejected or segmented explicitly—never sliced away.
 */

/** Largest manual `.srt`/`.vtt` accepted by one upload request. */
export const SUBTITLE_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;

/** Most cues accepted or mutated by one manual whole-track request. */
export const SUBTITLE_UPLOAD_MAX_CUES = 20_000;

/** Whole-file delivery threshold. Larger tracks require segmented delivery rather than truncation. */
export const SUBTITLE_WHOLE_TRACK_MAX_CUES = 20_000;
export const SUBTITLE_WHOLE_TRACK_MAX_ESTIMATED_BYTES = 10 * 1024 * 1024;

/** Bounded cue-window request limits. */
export const SUBTITLE_CUE_WINDOW_MAX_MS = 30 * 60 * 1_000;
export const SUBTITLE_CUE_WINDOW_MAX_CUES = 500;

/** Bounded mutations accepted in one editor save. */
export const SUBTITLE_SAVE_MAX_MUTATIONS = 500;

/**
 * @deprecated Legacy monolithic-worker compatibility only. The durable planner does not apply a
 * duration ceiling. Remove with the old worker rather than using this in new pipeline code.
 */
export const SUBTITLE_MAX_DURATION_SECONDS = Number.POSITIVE_INFINITY;

/**
 * @deprecated Legacy route compatibility only. New automatic target derivation consumes LOCALES
 * without a product cap; manual requests must validate finite catalog input explicitly.
 */
export const SUBTITLE_MAX_TARGETS = Number.MAX_SAFE_INTEGER;

/**
 * Compatibility alias for upload/edit callers. This is not a track storage cap; those callers must
 * return an explicit validation error instead of truncating input.
 */
export const SUBTITLE_MAX_CUES = Number.MAX_SAFE_INTEGER;

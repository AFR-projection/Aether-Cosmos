/**
 * How much slack upload endpoints get over the plain per-user API rate limit.
 *
 * A single file upload is several requests (presign → PUT → complete), and a
 * batch multiplies that again, so uploads would trip a limit tuned for page
 * loads. Scaling the admin's value keeps the setting meaningful in both
 * directions — lowering it still throttles uploads.
 *
 * `/api/folders/batch` shares this bucket: creating the directory tree is part of
 * a folder upload, and on the plain bucket a real project tripped the limit
 * mid-tree — the folders from earlier chunks were created, the upload aborted, and
 * the user was left with an empty skeleton.
 */
export const UPLOAD_RATE_MULTIPLIER = 5;

/**
 * Files per `POST /api/uploads/batch-init` call.
 *
 * Bounded by how long one request may hold a serverless invocation, not by payload
 * size: each entry costs a quota-reservation transaction and a presign. 200 keeps
 * the request comfortably sub-second while cutting a 5,000-file folder from 5,000
 * round trips to 25.
 */
export const BATCH_INIT_MAX_FILES = 200;

/** Sessions per `POST /api/uploads/batch-complete` call. Same reasoning as above. */
export const BATCH_COMPLETE_MAX_SESSIONS = 200;

/**
 * Parallel `initUpload` calls inside one batch-init.
 *
 * Every reservation updates the SAME `users` row, so these serialize on that row
 * lock no matter how high this goes; the win is in overlapping the presign and the
 * file insert around it. Past ~8 the added lock contention costs more than it saves.
 */
export const INIT_DB_CONCURRENCY = 8;

/** Parallel `completeUpload` calls inside one batch-complete. Each one HEADs R2. */
export const COMPLETE_DB_CONCURRENCY = 8;

/**
 * Below this, a file is "small" and rides the batched init/complete path.
 *
 * Above it, the per-file route is proportionally cheap and its resumability is
 * worth more than the saved handshake.
 */
export const SMALL_FILE_MAX_BYTES = 8 * 1024 * 1024;

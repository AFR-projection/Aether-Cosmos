/** Shared upload thresholds — safe for client and server. */

/** Files at or above this size use multipart upload. */
export const MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const MULTIPART_PARALLEL_PARTS = 4;

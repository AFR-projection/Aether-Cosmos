/**
 * How much slack upload endpoints get over the plain per-user API rate limit.
 *
 * A single file upload is several requests (presign → PUT → complete), and a
 * batch multiplies that again, so uploads would trip a limit tuned for page
 * loads. Scaling the admin's value keeps the setting meaningful in both
 * directions — lowering it still throttles uploads.
 */
export const UPLOAD_RATE_MULTIPLIER = 5;

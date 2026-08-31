/**
 * Webhook constants with no runtime dependencies.
 *
 * Kept out of `manage.ts` on purpose: that module opens the app's Drizzle client
 * at import time, and the worker builds its own connection instead. Importing
 * `manage.ts` from `workers/index.ts` just to read a string would give the worker
 * process a second Postgres pool it never uses.
 */

/**
 * Sent on every outbound delivery, by both the worker and the "send test event"
 * route. Shared so the two can never disagree — a receiver that filters on the
 * User-Agent would otherwise see test events as a different client. (The previous
 * value carried the "Stroge" typo from the original repository name.)
 */
export const WEBHOOK_USER_AGENT = "AetherCosmosByAFR-Webhook/1.0";

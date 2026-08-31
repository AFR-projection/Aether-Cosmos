import { z } from "zod";

/**
 * Query-parameter shapes that more than one list endpoint needs.
 *
 * `from`, `to` and `cursor` were `z.string().optional()` and went straight into
 * `new Date(...)`. `new Date("banana")` is an Invalid Date, not an error — it
 * reaches the driver as a broken parameter, so `?cursor=banana` on
 * `/api/files` or `/api/search` was a 500 (with a logged stack) from any
 * authenticated caller. The same string also became part of the Redis cache key,
 * so an unbounded one wrote an unbounded key.
 */

/** Longest timestamp string we accept — an ISO 8601 instant is well under this. */
const MAX_TIMESTAMP_LENGTH = 64;

/**
 * A timestamp query parameter, parsed to a `Date` or rejected as a 400.
 *
 * `Date.parse` is deliberate: it accepts the ISO strings the client actually sends
 * (`nextCursor` is `createdAt.toISOString()`) without pulling in a date library.
 */
export const timestampParam = z
  .string()
  .max(MAX_TIMESTAMP_LENGTH)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be a valid ISO date",
  })
  .transform((value) => new Date(value));

/** Longest free-text search we will build a tsquery (and a cache key) from. */
export const MAX_SEARCH_QUERY_LENGTH = 256;

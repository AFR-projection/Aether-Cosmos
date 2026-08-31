import { z } from "zod";

/**
 * The shape of a share token, checked before it is used for anything.
 *
 * `shares.token` is `text`, so an implausible token was not a type error — it was
 * a lookup. `/api/shared/[token]` and its `preview` sibling are the only routes a
 * signed-out caller can reach with a path segment of their choosing, and the PUT
 * handler additionally built a Redis rate-limit key out of it
 * (`share_edit:${token}`). A megabyte-long path segment therefore became a
 * megabyte-long cache key written by an anonymous caller.
 *
 * Tokens are `nanoid(32)`, i.e. 32 characters of the URL-safe alphabet. The bound
 * below is deliberately wider than that so an older or longer token still
 * resolves, and narrow enough that nothing else does.
 */

const SHARE_TOKEN_MIN_LENGTH = 8;
export const SHARE_TOKEN_MAX_LENGTH = 128;

const shareTokenSchema = z
  .string()
  .min(SHARE_TOKEN_MIN_LENGTH)
  .max(SHARE_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * True when `value` could be a share token at all.
 *
 * Callers answer 404 for false — the same answer as a token that simply does not
 * exist, so this adds no oracle. It only stops the unbounded value from reaching
 * a query or a cache key.
 */
export function isPossibleShareToken(value: string): boolean {
  return shareTokenSchema.safeParse(value).success;
}

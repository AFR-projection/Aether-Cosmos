import { z } from "zod";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { checkUserApiRateLimit } from "@/shared/lib/security";
import { BrainError, BrainValidationError } from "@brain/domain/errors";

/**
 * Small shared bits for the /api/brain route handlers.
 */

const uuidSchema = z.string().uuid();

/**
 * Path params arrive as raw strings. Handing a non-uuid straight to Postgres
 * raises "invalid input syntax for type uuid" — a 500 for what is a client typo.
 */
export function requireUuid(value: string, field: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new BrainValidationError(`${field} must be a UUID`);
  return parsed.data;
}

export class BrainRateLimitError extends BrainError {
  constructor() {
    super("Rate limit exceeded", 429, "RATE_LIMITED");
  }
}

/**
 * Per-user limit from the admin "Rate Limit" setting, in its own bucket so brain
 * traffic (agents poll far more than a browser does) cannot starve file uploads.
 */
export async function enforceBrainRateLimit(
  userId: string,
  bucket: string,
  multiplier = 1
): Promise<void> {
  const settings = await getAdminSettings();
  const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute, {
    bucket: `brain:${bucket}`,
    multiplier,
  });
  if (!rl.allowed) throw new BrainRateLimitError();
}

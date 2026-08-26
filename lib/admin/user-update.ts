import { z } from "zod";

/**
 * Validation and session consequences for an admin edit of another user's account.
 *
 * Two problems lived in these two routes:
 *
 *  - `PATCH /api/admin/users/[id]` parsed NOTHING. `await request.json()` was copied
 *    field by field onto the update, so `role: "root"` reached a pgEnum column (a
 *    500 from the driver rather than a 400), `quotaBytes: -1` and
 *    `quotaBytes: 1e30` reached a `bigint({mode:"number"})` column, an unbounded
 *    `username` reached an unbounded `text` column, and `mustChangePassword: "no"`
 *    was stored as truthy. The sibling `PATCH /api/admin/users` did parse, but left
 *    `username` unbounded on the update path while bounding it on create.
 *
 *  - Neither route revoked the target's sessions. An admin resetting a password to
 *    evict an attacker changed the credential and nothing else: every session
 *    cookie the attacker already held kept working, because sessions are opaque
 *    rows that carry no link to the password. The same held for `mustChangePassword`
 *    — enforced by a redirect in the page layouts, so an established session could
 *    keep driving the API without ever passing through it.
 *
 * Suspension was already immediate (`getSessionUser` re-reads `status` every
 * request), but the rows are revoked anyway so the sessions list an admin sees
 * matches what the account can actually do.
 */

/**
 * Largest quota we will store. The column is `bigint({ mode: "number" })`, so the
 * value round-trips through a JS number — 1 PiB is three orders of magnitude below
 * `Number.MAX_SAFE_INTEGER`, and any real quota is far under it.
 */
export const MAX_QUOTA_BYTES = 1024 ** 5;

/** Same bound the create path already used, applied to the update path too. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 50;

const quota = z.number().int().min(0).max(MAX_QUOTA_BYTES);

/**
 * The fields an admin may change. `role` and `status` are pgEnums in the schema, so
 * they are enumerated here — otherwise an invalid value is a driver error (500)
 * instead of a rejected request (400).
 */
export const adminUserUpdateSchema = z.object({
  username: z.string().trim().min(USERNAME_MIN).max(USERNAME_MAX).optional(),
  email: z.string().max(254).nullable().optional(),
  password: z.string().min(8).max(200).optional(),
  status: z.enum(["active", "suspended"]).optional(),
  suspendReason: z.string().max(500).nullable().optional(),
  mustChangePassword: z.boolean().optional(),
  quotaBytes: quota.optional(),
  bandwidthQuotaBytes: quota.optional(),
  role: z.enum(["user", "master"]).optional(),
});

export type AdminUserUpdate = z.infer<typeof adminUserUpdateSchema>;

/** The same schema with the target id in the body, for the collection route. */
export const adminUserUpdateByIdSchema = adminUserUpdateSchema.extend({
  id: z.string().uuid(),
});

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Normalize an admin-supplied email. Empty and null both mean "clear it".
 *
 * Kept out of the schema so the failure is a readable 400 instead of a zod path,
 * which is what the admin UI already showed for this field.
 */
export function normalizeAdminEmail(
  raw: string | null | undefined
): { ok: true; email: string | null } | { ok: false } {
  const trimmed = raw == null ? "" : String(raw).trim().toLowerCase();
  if (!trimmed) return { ok: true, email: null };
  if (!EMAIL_PATTERN.test(trimmed)) return { ok: false };
  return { ok: true, email: trimmed };
}

/** Why the target's sessions have to go, or null when the edit does not touch them. */
export type RevocationReason = "password_reset" | "suspended" | "must_change_password";

/**
 * Decide whether this edit invalidates the target's existing sessions.
 *
 * A password reset is the one that matters: it is the move an admin makes to evict
 * someone, and it is worthless while the old session rows survive.
 */
export function sessionRevocationReason(update: AdminUserUpdate): RevocationReason | null {
  if (update.password !== undefined) return "password_reset";
  if (update.status === "suspended") return "suspended";
  if (update.mustChangePassword === true) return "must_change_password";
  return null;
}

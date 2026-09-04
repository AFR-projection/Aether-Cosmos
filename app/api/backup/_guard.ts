import { requireAuth, type SessionUser } from "@/shared/lib/auth/session";
import { BackupForbiddenError } from "@backup/domain/errors";

/**
 * Who asked, reduced to the two fields the backup feature is allowed to know.
 *
 * Deliberately not `SessionUser`: the feature derives an account's scope from `id`, so a
 * third field is a third thing a future handler could be talked into trusting instead.
 */
export interface Requester {
  id: string;
  role: SessionUser["role"];
}

/**
 * The one authorization step every `/api/backup` route starts with.
 *
 * Two things it settles, both worth stating once rather than five times:
 *
 * 1. **The actor is the real signed-in account, never the impersonated one.** A
 *    master wearing another user's face keeps `role: "master"` and their own `id`,
 *    so nothing here would have broken — but an archive of somebody's whole `/files`
 *    is too large a thing to attribute through a session that says otherwise, and a
 *    takeout logged that way is an entry nobody can interpret later. So an
 *    impersonating session is refused outright.
 * 2. **Only `id` and `role` cross into the feature.** The scope of every export and
 *    every restore is the authenticated caller's own id, and the way to keep it that
 *    way is for no other id to be in scope at all.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §10.
 */
export async function requireBackupRequester(): Promise<{
  user: SessionUser;
  requester: Requester;
}> {
  const user = await requireAuth();

  if (user.isImpersonating) {
    throw new BackupForbiddenError(
      "Backups cannot be managed while impersonating another account. Stop impersonating first."
    );
  }

  return { user, requester: { id: user.id, role: user.role } };
}

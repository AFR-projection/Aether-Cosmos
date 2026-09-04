/**
 * Where an account's objects live in the bucket.
 *
 * Here rather than in the Files feature for the reason on `r2-client.ts` and
 * `r2-stream.ts`: two features now *write* objects — an upload and a per-account restore —
 * and the layer rules are right to refuse the second one an import of the first.
 *
 * The format has to live in exactly one place, and not because of tidiness. A key is the
 * only address an object has: spell it one way on write and another way on read and the
 * bytes are still in the bucket, still being paid for, and unreachable. So the restore path
 * generates its keys through this function rather than through a template that looks the
 * same today.
 */

/**
 * `users/<userId>/objects/<fileId>`.
 *
 * `filename` remains a compatibility argument for the ~20 existing call sites and is
 * deliberately unused: the name is not part of the identity, so a rename never moves an
 * object and two files with one name never collide through a sanitized key.
 */
export function buildR2Key(userId: string, fileId: string, filename?: string): string {
  void filename;
  return `users/${userId}/objects/${fileId}`;
}

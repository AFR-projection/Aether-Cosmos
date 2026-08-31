/**
 * The one place the app's HMAC/encryption secret is resolved.
 *
 * Three modules had their own copy of
 *
 *   `process.env.SESSION_SECRET || process.env.CSRF_SECRET || "dev-insecure-secret-change-me"`
 *
 * which is fine in development and a serious hole in production: with
 * SESSION_SECRET unset, the constant is public, so staged login tokens
 * (`src/shared/lib/security/step-code.ts`) become forgeable — an attacker who knows a user
 * id can mint a `step_code`-stage token and walk straight past the 2-Step Code
 * and authenticator layers — and every stored Gmail App Password
 * (`src/shared/infrastructure/email/crypto.ts`) is encrypted under a key anyone can derive.
 *
 * A missing secret in production is therefore a startup-class error, not a
 * default. Outside production the placeholder stays, because tests and
 * `next dev` must run without a configured secret.
 */

export const DEV_FALLBACK_SECRET = "dev-insecure-secret-change-me";

/** Below this, brute-forcing the HMAC key stops being theoretical. */
export const MIN_SECRET_LENGTH = 32;

let warned = false;

/**
 * Only the three variables this function reads are required, so a caller (or a
 * test) can pass a small object literal instead of a whole `ProcessEnv`.
 */
export type SecretEnv = Partial<
  Pick<NodeJS.ProcessEnv, "SESSION_SECRET" | "CSRF_SECRET" | "NODE_ENV">
>;

export function appSecret(env: SecretEnv = process.env): string {
  const secret = (env.SESSION_SECRET || env.CSRF_SECRET || "").trim();
  const production = env.NODE_ENV === "production";

  if (!secret) {
    if (production) {
      throw new Error(
        "SESSION_SECRET is not set. Refusing to fall back to a public development " +
          "secret — session/step-code tokens would be forgeable and stored email " +
          "credentials would be readable by anyone with the source."
      );
    }
    return DEV_FALLBACK_SECRET;
  }

  // Short-but-set is not worth taking a running deployment down for; it is worth
  // saying out loud exactly once per process.
  if (secret.length < MIN_SECRET_LENGTH && !warned) {
    warned = true;
    console.warn(
      `SESSION_SECRET is only ${secret.length} characters; use at least ${MIN_SECRET_LENGTH}.`
    );
  }
  return secret;
}

/** Test seam: lets a suite assert the warn-once behaviour deterministically. */
export function resetAppSecretWarning(): void {
  warned = false;
}

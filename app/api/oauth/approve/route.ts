import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/auth/session";
import { validateOAuthClientRedirect } from "@/lib/oauth/clients";
import { createAuthorizationCode } from "@/lib/oauth/codes";
import { parseScopes, clampScopesToRole } from "@/lib/oauth/constants";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every field was read as `String(body.x ?? "")` off an unparsed body, so: a JSON
 * `null` body threw a TypeError and answered 500; an object or array became
 * `"[object Object]"` and was stored; and `state`, `scope` and `code_challenge`
 * were unbounded strings written into the authorization-code row.
 *
 * `code_challenge_method` mattered most. It was stored verbatim, and
 * `verifyPkce` only ever accepts `S256` — so a client that sent `plain` (the other
 * method RFC 7636 defines) was handed a code that could never be exchanged, with
 * the failure surfacing much later as an opaque `invalid_grant`. The method is now
 * an enum of what this server actually implements, and the mismatch is refused
 * here, at the consent step.
 */
const approveSchema = z.object({
  client_id: z.string().trim().min(1).max(200),
  redirect_uri: z.string().trim().min(1).max(2048),
  scope: z.string().max(500).optional(),
  state: z.string().max(1024).optional(),
  // base64url of a SHA-256 digest is 43 characters; allow a little slack, not a lot.
  code_challenge: z
    .string()
    .trim()
    .min(43)
    .max(128)
    .regex(/^[A-Za-z0-9\-._~]+$/, "must be base64url"),
  code_challenge_method: z.literal("S256").default("S256"),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) {
      return apiError("Invalid CSRF token", 403);
    }

    const session = await requireAuth();
    const body = approveSchema.parse(await request.json());

    const clientCheck = await validateOAuthClientRedirect(body.client_id, body.redirect_uri);
    if (!clientCheck.ok) {
      return apiError(
        clientCheck.error === "invalid_redirect_uri"
          ? "Redirect URI does not match the OAuth client"
          : "Invalid OAuth client",
        400
      );
    }

    const requestedScopes = parseScopes(body.scope ?? "read");
    // SECURITY: never trust the requested scope set. Clamp to what this account's
    // role is allowed to hold — a non-master user can never be granted admin:* /
    // supreme, even if the client asked and the user clicked Allow.
    const scopes = clampScopesToRole(requestedScopes, session.role);
    const code = await createAuthorizationCode({
      clientId: body.client_id,
      userId: session.id,
      redirectUri: body.redirect_uri,
      scopes,
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method,
    });

    const redirect = new URL(body.redirect_uri);
    redirect.searchParams.set("code", code);
    if (body.state) redirect.searchParams.set("state", body.state);

    return apiSuccess({ redirect_to: redirect.toString() });
  } catch (e) {
    return handleApiError(e);
  }
}

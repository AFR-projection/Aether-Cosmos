import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { oauthClients } from "@/lib/db/schema";
import {
  generateClientId,
  generateClientSecret,
  hashSecret,
  isAllowedRedirectUri,
  LOOPBACK_HOSTS,
} from "@/lib/oauth/constants";

export type RegisterClientInput = {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
};

/**
 * Bounds on what dynamic client registration will store.
 *
 * `POST /api/oauth/register` is unauthenticated by design (RFC 7591), and it wrote
 * `client_name`, `redirect_uris`, `grant_types` and `response_types` into jsonb
 * columns with no length, count or vocabulary check at all — so one request could
 * park megabytes of attacker-chosen text in the table, and `grant_types` could name
 * a grant the token endpoint does not implement.
 */
const GRANT_TYPES = [
  "authorization_code",
  "refresh_token",
  "client_credentials",
] as const;
const RESPONSE_TYPES = ["code"] as const;
const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;

/** Long enough for a real callback, short enough to be a row and not a payload. */
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_REDIRECT_URIS = 10;

export const registerClientSchema = z.object({
  client_name: z.string().trim().min(1).max(200).optional(),
  redirect_uris: z
    .array(z.string().max(MAX_REDIRECT_URI_LENGTH))
    .min(1)
    .max(MAX_REDIRECT_URIS),
  grant_types: z.array(z.enum(GRANT_TYPES)).min(1).max(GRANT_TYPES.length).optional(),
  response_types: z.array(z.enum(RESPONSE_TYPES)).min(1).max(RESPONSE_TYPES.length).optional(),
  token_endpoint_auth_method: z.enum(AUTH_METHODS).optional(),
});

export type RegisterClientResult = {
  client_id: string;
  client_secret?: string;
  client_name?: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  client_id_issued_at: number;
};

export async function registerOAuthClient(input: RegisterClientInput): Promise<RegisterClientResult> {
  const parsed = registerClientSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "input";
    throw new OAuthClientError(`Invalid ${field}: ${issue?.message ?? "invalid value"}`, 400);
  }
  const metadata = parsed.data;

  for (const uri of metadata.redirect_uris) {
    if (!isAllowedRedirectUri(uri)) {
      throw new OAuthClientError(`Invalid redirect_uri: ${uri}`, 400);
    }
  }

  const authMethod = metadata.token_endpoint_auth_method ?? "none";
  const clientId = generateClientId();
  let clientSecret: string | undefined;
  let clientSecretHash: string | null = null;

  if (authMethod === "client_secret_post") {
    clientSecret = generateClientSecret();
    clientSecretHash = hashSecret(clientSecret);
  }

  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash,
    clientName: metadata.client_name ?? null,
    redirectUris: metadata.redirect_uris,
    grantTypes: metadata.grant_types ?? ["authorization_code", "refresh_token"],
    responseTypes: metadata.response_types ?? ["code"],
    tokenEndpointAuthMethod: authMethod,
  });

  return {
    client_id: clientId,
    client_secret: clientSecret,
    client_name: metadata.client_name,
    redirect_uris: metadata.redirect_uris,
    grant_types: metadata.grant_types ?? ["authorization_code", "refresh_token"],
    response_types: metadata.response_types ?? ["code"],
    token_endpoint_auth_method: authMethod,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}

export async function getOAuthClient(clientId: string) {
  const [row] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return row ?? null;
}

export async function validateOAuthClientRedirect(
  clientId: string,
  redirectUri: string
): Promise<{ ok: true; client: NonNullable<Awaited<ReturnType<typeof getOAuthClient>>> } | { ok: false; error: string }> {
  const client = await getOAuthClient(clientId);
  if (!client) return { ok: false, error: "invalid_client" };
  if (!isAllowedRedirectUri(redirectUri)) {
    return { ok: false, error: "invalid_redirect_uri" };
  }
  if (redirectUriAllowedForClient(client.redirectUris, redirectUri)) {
    return { ok: true, client };
  }
  return { ok: false, error: "invalid_redirect_uri" };
}

/**
 * Exact-match, with one RFC 8252 exception: loopback redirects (http://127.0.0.1,
 * http://localhost, http://[::1]) may differ only by port, because native clients
 * bind an ephemeral port at runtime. Everything else must match byte-for-byte —
 * no host-only matching (that would allow open redirects within a trusted host).
 */
function redirectUriAllowedForClient(registeredUris: string[], redirectUri: string): boolean {
  if (registeredUris.includes(redirectUri)) return true;

  let requested: URL;
  try {
    requested = new URL(redirectUri);
  } catch {
    return false;
  }

  const isLoopback =
    requested.protocol === "http:" &&
    LOOPBACK_HOSTS.includes(requested.hostname.toLowerCase());
  if (!isLoopback) return false;

  // Loopback: match on everything except the port.
  return registeredUris.some((registered) => {
    let reg: URL;
    try {
      reg = new URL(registered);
    } catch {
      return false;
    }
    return (
      reg.protocol === "http:" &&
      LOOPBACK_HOSTS.includes(reg.hostname.toLowerCase()) &&
      reg.hostname.toLowerCase() === requested.hostname.toLowerCase() &&
      reg.pathname === requested.pathname
    );
  });
}

export class OAuthClientError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

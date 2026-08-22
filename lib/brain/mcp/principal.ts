import { and, asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brainAccess, brainAgents, brains } from "@/lib/db/schema";
import { authenticateApiKey, keyHasScope } from "@/lib/auth/api-key";
import { AuthError } from "@/lib/auth/session";
import {
  BRAIN_API_SCOPES,
  brainScopeSatisfied,
  expandBrainScopes,
  type BrainApiScope,
} from "@/lib/brain/constants";
import { BrainForbiddenError, BrainNotFoundError } from "@/lib/brain/errors";

/**
 * Who is calling the MCP server, and which brains may they touch.
 *
 * §90: agent identity and brain identity are separate. One agent key may hold
 * grants on several brains, so every tool call resolves a brain out of the
 * principal's grant list — an agent can never name a brain it was not granted,
 * and never one belonging to another account.
 */

export type BrainGrant = {
  brainId: string;
  brainName: string;
  isDefault: boolean;
  scopes: BrainApiScope[];
};

export type McpPrincipal = {
  type: "user" | "agent";
  /** brain_audit_logs.principal_id */
  id: string;
  userId: string;
  agentId: string | null;
  agentName: string | null;
  apiKeyId: string;
  grants: BrainGrant[];
};

/**
 * Effective scopes for one grant: the grant's own scopes expanded through the
 * implication table (so `brain.full` and `brain.write`→`brain.link` mean the same
 * thing here as on the REST routes), intersected with what the API key carries.
 *
 * Both halves go through the shared helpers in lib/brain/constants.ts. Rolling
 * our own membership test here is what let MCP drift stricter than REST.
 *
 * Exported so the parity regression test can compare this against the REST
 * predicate directly instead of re-implementing it.
 */
export function effectiveGrantScopes(
  grantScopes: readonly string[],
  keyScopes: readonly string[]
): BrainApiScope[] {
  return expandBrainScopes(grantScopes).filter((scope) =>
    keyHasScope([...keyScopes], scope)
  );
}

/**
 * Authenticate an `sk_` API key and expand it into a principal plus its grants.
 *
 * OAuth access tokens are rejected on purpose: brain.* scopes are not part of
 * OAUTH_SCOPES, so an OAuth token can never legitimately carry one, and letting
 * it through would only create a confusing second path to the same check.
 */
export async function resolveMcpPrincipal(token: string): Promise<McpPrincipal> {
  if (!token.startsWith("sk_") && !token.startsWith("skm_")) {
    throw new AuthError("A Storage ByAFR API key (sk_…) is required", 401);
  }

  const user = await authenticateApiKey(token, []);

  // The key must carry at least one brain scope; a storage-only key has no
  // business on this endpoint even though it authenticates fine.
  const keyScopes = user.apiKeyScopes ?? [];
  if (!BRAIN_API_SCOPES.some((scope) => keyHasScope(keyScopes, scope))) {
    throw new BrainForbiddenError(
      "This API key carries no brain.* scope. Create an agent under a brain to get one."
    );
  }

  const [agent] = await db
    .select()
    .from(brainAgents)
    .where(
      and(eq(brainAgents.apiKeyId, user.apiKeyId), eq(brainAgents.ownerUserId, user.id))
    )
    .limit(1);

  if (!agent) {
    // A plain user key with brain scopes acts as the owner over every brain.
    const owned = await db
      .select()
      .from(brains)
      .where(eq(brains.ownerUserId, user.id))
      .orderBy(asc(brains.createdAt));

    return {
      type: "user",
      id: user.id,
      userId: user.id,
      agentId: null,
      agentName: null,
      apiKeyId: user.apiKeyId,
      grants: owned.map((brain) => ({
        brainId: brain.id,
        brainName: brain.name,
        isDefault: brain.isDefault,
        scopes: effectiveGrantScopes(keyScopes, keyScopes),
      })),
    };
  }

  if (agent.status !== "active") {
    throw new BrainForbiddenError("This agent has been revoked");
  }

  const rows = await db
    .select({
      brainId: brains.id,
      brainName: brains.name,
      isDefault: brains.isDefault,
      status: brains.status,
      scopes: brainAccess.scopes,
    })
    .from(brainAccess)
    .innerJoin(brains, eq(brains.id, brainAccess.brainId))
    .where(
      and(
        eq(brainAccess.principalType, "agent"),
        eq(brainAccess.principalId, agent.id),
        eq(brains.ownerUserId, user.id)
      )
    )
    .orderBy(asc(brains.createdAt));

  return {
    type: "agent",
    id: agent.id,
    userId: user.id,
    agentId: agent.id,
    agentName: agent.name,
    apiKeyId: user.apiKeyId,
    grants: rows.map((row) => ({
      brainId: row.brainId,
      brainName: row.brainName,
      isDefault: row.isDefault,
      // Effective scopes are the INTERSECTION of the key's scopes and the grant's:
      // narrowing either one narrows the agent.
      scopes: effectiveGrantScopes(row.scopes ?? [], keyScopes),
    })),
  };
}

/**
 * Pick the brain a tool call targets and check the scope in one step.
 *
 * With no brainId the default (or single) grant is used, so a single-brain agent
 * never has to pass one. An explicit brainId must appear in the grant list.
 */
export function requireGrant(
  principal: McpPrincipal,
  brainId: string | undefined,
  scope: BrainApiScope
): BrainGrant {
  if (principal.grants.length === 0) {
    throw new BrainForbiddenError("This credential has no brain access");
  }

  let grant: BrainGrant | undefined;
  if (brainId) {
    grant = principal.grants.find((candidate) => candidate.brainId === brainId);
    if (!grant) throw new BrainNotFoundError();
  } else {
    grant =
      principal.grants.find((candidate) => candidate.isDefault) ?? principal.grants[0];
  }

  // Same predicate the REST choke point uses (lib/brain/access.ts), so a scope
  // that opens a route over HTTP opens the equivalent MCP tool and nothing more.
  if (!brainScopeSatisfied(grant.scopes, scope)) {
    throw new BrainForbiddenError(`Missing scope: ${scope}`);
  }
  return grant;
}

import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { brainAccess, brainAgents, type Brain } from "@/lib/db/schema";
import { isApiKeySession, requireAuthOrApiKey } from "@/lib/auth/api-key";
import { getEffectiveUserId } from "@/lib/auth/permissions";
import type { SessionUser } from "@/lib/auth/session";
import { requireBrainForUser } from "./brain-service";
import { BrainConflictError, BrainForbiddenError } from "./errors";
import { brainScopeSatisfied, type BrainApiScope } from "./constants";

/**
 * Single authorization choke point for every /api/brain route.
 *
 * Two kinds of caller reach these routes:
 *  - the owner over a session cookie — full power over their own brains;
 *  - a brain agent over its `sk_` key — power limited twice over, first by the
 *    key's brain.* scopes and again by the brain_access row that grants that
 *    agent this specific brain. Revoking either one locks the agent out.
 *
 * Everything below throws typed BrainErrors, which handleApiError turns into the
 * right status code.
 */

export type BrainPrincipal = {
  type: "user" | "agent";
  /** brain_audit_logs.principal_id — the user id, or the agent id. */
  id: string;
  /** Set only for agent callers; used for memories.created_by_agent. */
  agentId: string | null;
  /** Agent display name, for audit metadata. */
  agentName: string | null;
};

export type BrainContext = {
  sessionUser: SessionUser;
  userId: string;
  brain: Brain;
  principal: BrainPrincipal;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function requireBrainContext(
  request: NextRequest,
  brainId: string,
  requiredScopes: BrainApiScope[],
  opts?: { write?: boolean }
): Promise<BrainContext> {
  const sessionUser = await requireAuthOrApiKey(request, requiredScopes);
  const userId = getEffectiveUserId(sessionUser);
  const brain = await requireBrainForUser(brainId, userId);

  if (opts?.write && brain.status === "archived") {
    throw new BrainConflictError("This brain is archived and is read-only");
  }

  const principal = await resolvePrincipal(sessionUser, userId, brainId, requiredScopes);
  return { sessionUser, userId, brain, principal };
}

/**
 * Same as requireBrainContext but refuses agent callers. For routes an agent must
 * never reach even with a valid grant: the audit trail, agent management, export.
 */
export async function requireBrainOwnerContext(
  request: NextRequest,
  brainId: string,
  requiredScopes: BrainApiScope[],
  opts?: { write?: boolean }
): Promise<BrainContext> {
  const context = await requireBrainContext(request, brainId, requiredScopes, opts);
  if (context.principal.type === "agent") {
    throw new BrainForbiddenError("This endpoint is restricted to the brain owner");
  }
  return context;
}

/**
 * Auth for the collection routes that are not scoped to one brain
 * (`GET/POST /api/brain`). Agent keys are rejected here: creating and listing
 * brains is an owner-level operation.
 */
export async function requireBrainOwner(
  request: NextRequest,
  requiredScopes: BrainApiScope[]
): Promise<{ sessionUser: SessionUser; userId: string }> {
  const sessionUser = await requireAuthOrApiKey(request, requiredScopes);
  const userId = getEffectiveUserId(sessionUser);

  if (isApiKeySession(sessionUser)) {
    const agent = await findAgentForKey(sessionUser.apiKeyId, userId);
    if (agent) {
      throw new BrainForbiddenError("Agent keys cannot manage brains");
    }
  }

  return { sessionUser, userId };
}

async function resolvePrincipal(
  sessionUser: SessionUser,
  userId: string,
  brainId: string,
  requiredScopes: BrainApiScope[]
): Promise<BrainPrincipal> {
  if (!isApiKeySession(sessionUser)) {
    return { type: "user", id: userId, agentId: null, agentName: null };
  }

  const agent = await findAgentForKey(sessionUser.apiKeyId, userId);
  if (!agent) {
    // A plain user key that was granted brain.* scopes directly — acts as the owner.
    return { type: "user", id: userId, agentId: null, agentName: null };
  }

  if (agent.status !== "active") {
    throw new BrainForbiddenError("This agent has been revoked");
  }

  const [access] = await db
    .select({ scopes: brainAccess.scopes })
    .from(brainAccess)
    .where(
      and(
        eq(brainAccess.brainId, brainId),
        eq(brainAccess.principalType, "agent"),
        eq(brainAccess.principalId, agent.id)
      )
    )
    .limit(1);

  if (!access) {
    throw new BrainForbiddenError("This agent has no access to this brain");
  }

  const granted = access.scopes ?? [];
  const missing = requiredScopes.filter((scope) => !brainScopeSatisfied(granted, scope));
  if (missing.length > 0) {
    throw new BrainForbiddenError(`Agent is missing scope: ${missing.join(", ")}`);
  }

  return { type: "agent", id: agent.id, agentId: agent.id, agentName: agent.name };
}

async function findAgentForKey(apiKeyId: string, ownerUserId: string) {
  // OAuth sessions use a synthetic `oauth:<clientId>` id — never an agent key.
  if (!UUID_RE.test(apiKeyId)) return null;

  const [agent] = await db
    .select()
    .from(brainAgents)
    .where(and(eq(brainAgents.apiKeyId, apiKeyId), eq(brainAgents.ownerUserId, ownerUserId)))
    .limit(1);
  return agent ?? null;
}

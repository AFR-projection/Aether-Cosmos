import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { apiKeys, brainAccess, brainAgents, type BrainAgent } from "@/lib/db/schema";
import { createNamespacedApiKey } from "@/lib/auth/api-key";
import {
  BRAIN_API_SCOPES,
  DEFAULT_BRAIN_AGENT_SCOPES,
  normalizeBrainScopes,
  type BrainApiScope,
} from "./constants";
import { BrainAgentNotFoundError, BrainConflictError, BrainValidationError } from "./errors";

export { BRAIN_API_SCOPES };
export type { BrainApiScope };

/** Cap so a brain cannot be handed out to an unbounded number of agents. */
export const MAX_AGENTS_PER_USER = 20;

export type BrainAgentWithScopes = BrainAgent & { scopes: string[] };

/**
 * Mint an agent: one `sk_` API key carrying only brain.* scopes, one agent row,
 * and one brain_access grant. All three in a single transaction — the first cut
 * created the key first and outside any transaction, so a failure on the grant
 * left a live credential with no owning agent.
 *
 * The raw key is returned once and never stored in plaintext.
 */
export async function createBrainAgent(params: {
  userId: string;
  brainId: string;
  name: string;
  description?: string;
  type?: string;
  scopes?: readonly string[];
}): Promise<{ agent: BrainAgentWithScopes; rawKey: string }> {
  const name = params.name.trim();
  if (!name) throw new BrainValidationError("Agent name is required");

  const scopes = params.scopes
    ? normalizeBrainScopes(params.scopes)
    : [...DEFAULT_BRAIN_AGENT_SCOPES];
  if (scopes.length === 0) {
    throw new BrainValidationError("At least one brain scope is required");
  }

  const active = await db
    .select({ id: brainAgents.id })
    .from(brainAgents)
    .where(and(eq(brainAgents.ownerUserId, params.userId), eq(brainAgents.status, "active")));
  if (active.length >= MAX_AGENTS_PER_USER) {
    throw new BrainConflictError(`Maximum ${MAX_AGENTS_PER_USER} active agents allowed`);
  }

  // Outside the transaction: creating the key hashes a secret (argon2) and
  // enforces the account's key quota, and it is the step most likely to reject.
  const key = await createNamespacedApiKey(params.userId, `brain:${name}`, scopes, null);

  try {
    const agent = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(brainAgents)
        .values({
          ownerUserId: params.userId,
          name,
          description: params.description?.trim() || null,
          type: params.type?.trim() || "agent",
          apiKeyId: key.id,
        })
        .returning();

      await tx.insert(brainAccess).values({
        brainId: params.brainId,
        principalType: "agent",
        principalId: created.id,
        role: "agent",
        scopes,
      });

      return created;
    });

    return { agent: { ...agent, scopes }, rawKey: key.rawKey };
  } catch (error) {
    // Never leave an orphaned credential behind.
    await db.delete(apiKeys).where(eq(apiKeys.id, key.id));
    throw error;
  }
}

/** Every agent the user owns, newest last. */
export async function listBrainAgents(userId: string): Promise<BrainAgent[]> {
  return db
    .select()
    .from(brainAgents)
    .where(eq(brainAgents.ownerUserId, userId))
    .orderBy(asc(brainAgents.createdAt));
}

/**
 * Agents that hold a grant on this brain, with the scopes of that grant.
 * One query with an IN filter — the first cut pulled every agent the user owns
 * and filtered in JS.
 */
export async function listAgentsForBrain(
  brainId: string,
  userId: string
): Promise<BrainAgentWithScopes[]> {
  const grants = await db
    .select({ principalId: brainAccess.principalId, scopes: brainAccess.scopes })
    .from(brainAccess)
    .where(and(eq(brainAccess.brainId, brainId), eq(brainAccess.principalType, "agent")));

  if (grants.length === 0) return [];

  const scopesByAgent = new Map(grants.map((g) => [g.principalId, g.scopes ?? []]));
  const rows = await db
    .select()
    .from(brainAgents)
    .where(
      and(
        eq(brainAgents.ownerUserId, userId),
        inArray(brainAgents.id, [...scopesByAgent.keys()])
      )
    )
    .orderBy(asc(brainAgents.createdAt));

  return rows.map((agent) => ({ ...agent, scopes: scopesByAgent.get(agent.id) ?? [] }));
}

async function requireAgent(userId: string, agentId: string): Promise<BrainAgent> {
  const [agent] = await db
    .select()
    .from(brainAgents)
    .where(and(eq(brainAgents.id, agentId), eq(brainAgents.ownerUserId, userId)))
    .limit(1);
  if (!agent) throw new BrainAgentNotFoundError();
  return agent;
}

/** Grant (or re-scope) an existing agent's access to a brain. */
export async function grantBrainAccess(params: {
  brainId: string;
  userId: string;
  agentId: string;
  scopes?: readonly string[];
}): Promise<string[]> {
  const agent = await requireAgent(params.userId, params.agentId);
  if (agent.status !== "active") {
    throw new BrainConflictError("This agent has been revoked");
  }

  const scopes = params.scopes
    ? normalizeBrainScopes(params.scopes)
    : [...DEFAULT_BRAIN_AGENT_SCOPES];
  if (scopes.length === 0) {
    throw new BrainValidationError("At least one brain scope is required");
  }

  await db
    .insert(brainAccess)
    .values({
      brainId: params.brainId,
      principalType: "agent",
      principalId: params.agentId,
      role: "agent",
      scopes,
    })
    .onConflictDoUpdate({
      target: [brainAccess.brainId, brainAccess.principalType, brainAccess.principalId],
      set: { scopes, updatedAt: new Date() },
    });

  return scopes;
}

/** Drop an agent's access to one brain. Its key stays valid for other brains. */
export async function revokeBrainAccess(params: {
  brainId: string;
  userId: string;
  agentId: string;
}): Promise<boolean> {
  await requireAgent(params.userId, params.agentId);

  const removed = await db
    .delete(brainAccess)
    .where(
      and(
        eq(brainAccess.brainId, params.brainId),
        eq(brainAccess.principalType, "agent"),
        eq(brainAccess.principalId, params.agentId)
      )
    )
    .returning({ id: brainAccess.id });

  return removed.length > 0;
}

/**
 * Kill an agent everywhere: mark it revoked, delete its API key, and drop every
 * brain grant it holds. Access checks stop at the first of those, but all three
 * matter — a lingering grant would come back to life if the id were reused, and
 * a lingering key would keep authenticating against non-brain routes.
 */
export async function revokeBrainAgent(userId: string, agentId: string): Promise<BrainAgent> {
  const agent = await requireAgent(userId, agentId);

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(brainAgents)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(brainAgents.id, agentId))
      .returning();

    await tx
      .delete(brainAccess)
      .where(
        and(eq(brainAccess.principalType, "agent"), eq(brainAccess.principalId, agentId))
      );

    if (agent.apiKeyId) {
      await tx.delete(apiKeys).where(eq(apiKeys.id, agent.apiKeyId));
    }

    return updated;
  });
}

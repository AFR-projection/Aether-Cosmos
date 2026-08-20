import { NextRequest } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/lib/auth/session";
import { logActivity } from "@/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainOwnerContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import {
  grantBrainAccess,
  revokeBrainAccess,
  revokeBrainAgent,
} from "@/lib/brain/agent-service";
import { BRAIN_API_SCOPES } from "@/lib/brain/constants";

type RouteParams = { params: Promise<{ id: string; agentId: string }> };

async function ids(params: RouteParams["params"]) {
  const { id, agentId } = await params;
  return {
    brainId: requireUuid(id, "id"),
    agentId: requireUuid(agentId, "agentId"),
  };
}

const patchSchema = z
  .object({
    scopes: z.array(z.enum(BRAIN_API_SCOPES)).min(1).optional(),
    status: z.literal("revoked").optional(),
  })
  .refine((body) => body.scopes !== undefined || body.status !== undefined, {
    message: "Provide scopes or status",
  });

/**
 * PATCH /api/brain/[id]/agents/[agentId]
 *  - `{ scopes: [...] }`      → re-scope (or re-grant) this agent on this brain
 *  - `{ status: "revoked" }`  → kill the agent everywhere: its key is deleted and
 *                               every brain grant it holds is dropped
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, agentId } = await ids(params);
    const { sessionUser, userId, principal } = await requireBrainOwnerContext(
      request,
      brainId,
      ["brain.write"]
    );
    await enforceBrainRateLimit(userId, "write");

    const body = patchSchema.parse(await request.json());

    if (body.status === "revoked") {
      const agent = await revokeBrainAgent(userId, agentId);

      await logBrainAudit({
        brainId,
        principalType: principal.type,
        principalId: principal.id,
        operation: "agent.revoke",
        resourceType: "brain_agent",
        resourceId: agentId,
        metadata: { name: agent.name },
      });
      await logActivity(sessionUser, "delete", {
        resourceType: "brain_agent",
        resourceId: agentId,
        metadata: { action: "revoke", name: agent.name },
        ip: getClientIp(request),
      });

      return apiSuccess({ agent, revoked: true });
    }

    const scopes = await grantBrainAccess({ brainId, userId, agentId, scopes: body.scopes });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "agent.scopes",
      resourceType: "brain_agent",
      resourceId: agentId,
      metadata: { scopes },
    });

    return apiSuccess({ agentId, scopes });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/brain/[id]/agents/[agentId] — drop this agent's access to THIS brain.
 * The agent and its key survive for any other brain it was granted.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, agentId } = await ids(params);
    const { sessionUser, userId, principal } = await requireBrainOwnerContext(
      request,
      brainId,
      ["brain.write"]
    );
    await enforceBrainRateLimit(userId, "write");

    const removed = await revokeBrainAccess({ brainId, userId, agentId });
    if (!removed) {
      return apiError("This agent has no access to this brain", 404, {
        code: "BRAIN_ACCESS_NOT_FOUND",
      });
    }

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "agent.access_revoke",
      resourceType: "brain_agent",
      resourceId: agentId,
    });
    await logActivity(sessionUser, "edit", {
      resourceType: "brain_agent",
      resourceId: agentId,
      metadata: { action: "revoke_access", brainId },
      ip: getClientIp(request),
    });

    return apiSuccess({ revoked: true });
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainOwnerContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { createBrainAgent, listAgentsForBrain, MAX_AGENTS_PER_USER } from "@brain/application/commands/agent-service";
import { BRAIN_API_SCOPES, DEFAULT_BRAIN_AGENT_SCOPES } from "@brain/domain/constants";

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/brain/[id]/agents — agents holding a grant on this brain. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId } = await requireBrainOwnerContext(request, brainId, ["brain.read"]);

    const agents = await listAgentsForBrain(brainId, userId);
    return apiSuccess({
      agents,
      availableScopes: BRAIN_API_SCOPES,
      defaultScopes: DEFAULT_BRAIN_AGENT_SCOPES,
      maxAgents: MAX_AGENTS_PER_USER,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional(),
  type: z.string().trim().max(50).optional(),
  scopes: z.array(z.enum(BRAIN_API_SCOPES)).min(1).optional(),
});

/**
 * POST /api/brain/[id]/agents — mint an agent plus its API key.
 *
 * `rawKey` is the only time the secret is ever readable; only its hash is stored.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { sessionUser, userId, principal } = await requireBrainOwnerContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write");

    const body = createSchema.parse(await request.json());
    const { agent, rawKey } = await createBrainAgent({ ...body, userId, brainId });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "agent.create",
      resourceType: "brain_agent",
      resourceId: agent.id,
      metadata: { name: agent.name, scopes: agent.scopes },
    });
    await logActivity(sessionUser, "edit", {
      resourceType: "brain_agent",
      resourceId: agent.id,
      metadata: { action: "create", name: agent.name, scopes: agent.scopes, brainId },
      ip: getClientIp(request),
    });

    return apiSuccess({ agent, rawKey }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

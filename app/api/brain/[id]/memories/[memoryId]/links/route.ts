import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { publishToUser } from "@/lib/realtime/events";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { getMemoryLinks, linkMemory } from "@/lib/brain/link-service";
import { requireMemory } from "@/lib/brain/memory-service";

type RouteParams = { params: Promise<{ id: string; memoryId: string }> };

async function ids(params: RouteParams["params"]) {
  const { id, memoryId } = await params;
  return {
    brainId: requireUuid(id, "id"),
    memoryId: requireUuid(memoryId, "memoryId"),
  };
}

/**
 * GET /api/brain/[id]/memories/[memoryId]/links — both directions in one call:
 * `relatedTo` (links this memory declares) and `referencedBy` (§41 backlinks — the
 * half a client cannot compute on its own).
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brainId, memoryId } = await ids(params);
    await requireBrainContext(request, brainId, ["brain.read"]);

    // 404 before returning empty lists, so a foreign memory id is indistinguishable
    // from one that simply has no links.
    await requireMemory(brainId, memoryId);
    const links = await getMemoryLinks({ brainId, memoryId });

    return apiSuccess(links);
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z
  .object({
    targetMemoryId: z.string().uuid().optional(),
    targetEntityId: z.string().uuid().optional(),
    linkType: z.string().trim().min(1).max(64).optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine(
    (body) => Boolean(body.targetMemoryId) !== Boolean(body.targetEntityId),
    { message: "Provide exactly one of targetMemoryId or targetEntityId" }
  );

/**
 * POST /api/brain/[id]/memories/[memoryId]/links — link this memory to another
 * memory or to an entity of the SAME brain. Both endpoints are re-resolved inside
 * the brain before the row is written, so a foreign id 404s instead of creating a
 * cross-brain edge.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, memoryId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.link"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const body = createSchema.parse(await request.json());
    const link = await linkMemory({
      brainId,
      sourceMemoryId: memoryId,
      target: body.targetMemoryId
        ? { targetType: "memory", targetMemoryId: body.targetMemoryId }
        : { targetType: "entity", targetEntityId: body.targetEntityId! },
      linkType: body.linkType,
      metadata: body.metadata ?? null,
      principal: { userId, agentId: principal.agentId },
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.linked",
      resourceType: "memory_link",
      resourceId: link.id,
      metadata: {
        sourceMemoryId: memoryId,
        targetType: link.targetType,
        linkType: link.linkType,
        agent: principal.agentName,
      },
    });

    await publishToUser(userId, {
      type: "brain_memory_linked",
      brainId,
      memoryId,
      linkId: link.id,
      targetType: link.targetType,
    });

    return apiSuccess({ link }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}

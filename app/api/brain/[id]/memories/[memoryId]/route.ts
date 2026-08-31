import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { publishToUser } from "@/shared/infrastructure/realtime/events";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { deleteMemory, getMemory, updateMemory } from "@brain/application/commands/memory-service";
import { MEMORY_TYPES } from "@brain/domain/constants";

type RouteParams = { params: Promise<{ id: string; memoryId: string }> };

async function ids(params: RouteParams["params"]) {
  const { id, memoryId } = await params;
  return {
    brainId: requireUuid(id, "id"),
    memoryId: requireUuid(memoryId, "memoryId"),
  };
}

/** GET /api/brain/[id]/memories/[memoryId] */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brainId, memoryId } = await ids(params);
    await requireBrainContext(request, brainId, ["brain.read"]);

    const memory = await getMemory({ brainId, memoryId });
    if (!memory) return apiError("Memory not found", 404, { code: "MEMORY_NOT_FOUND" });

    return apiSuccess({ memory });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z
  .object({
    type: z.enum(MEMORY_TYPES).optional(),
    title: z.string().trim().min(1).max(300).optional(),
    content: z.string().min(1).max(200_000).optional(),
    summary: z.string().trim().max(1000).nullable().optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    projectId: z.string().uuid().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
    archived: z.boolean().optional(),
    changeReason: z.string().trim().max(300).optional(),
  })
  .refine((body) => Object.keys(body).some((key) => key !== "changeReason"), {
    message: "Provide at least one field to update",
  });

/** PATCH /api/brain/[id]/memories/[memoryId] — edits snapshot a version first. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, memoryId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const { changeReason, ...data } = patchSchema.parse(await request.json());
    const memory = await updateMemory({
      brainId,
      memoryId,
      principal: { userId, agentId: principal.agentId },
      data,
      changeReason,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.update",
      resourceType: "memory",
      resourceId: memoryId,
      metadata: { fields: Object.keys(data), changeReason, agent: principal.agentName },
    });

    await publishToUser(userId, { type: "brain_memory_updated", brainId, memoryId });

    return apiSuccess({ memory });
  } catch (error) {
    return handleApiError(error);
  }
}

/** DELETE /api/brain/[id]/memories/[memoryId] — soft delete. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, memoryId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.delete"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    // Reports 404 when nothing matched — the first cut answered "deleted: true"
    // for ids that never existed.
    const deleted = await deleteMemory({ brainId, memoryId });
    if (!deleted) return apiError("Memory not found", 404, { code: "MEMORY_NOT_FOUND" });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.delete",
      resourceType: "memory",
      resourceId: memoryId,
      metadata: { agent: principal.agentName },
    });

    await publishToUser(userId, { type: "brain_memory_deleted", brainId, memoryId });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

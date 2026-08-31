import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import {
  deleteEntity,
  listRelationships,
  requireEntity,
  updateEntity,
} from "@brain/application/queries/graph-service";
import { BRAIN_ENTITY_TYPES } from "@brain/domain/constants";

type RouteParams = { params: Promise<{ id: string; entityId: string }> };

async function ids(params: RouteParams["params"]) {
  const { id, entityId } = await params;
  return {
    brainId: requireUuid(id, "id"),
    entityId: requireUuid(entityId, "entityId"),
  };
}

/** GET /api/brain/[id]/entities/[entityId] — the node plus every edge touching it. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brainId, entityId } = await ids(params);
    await requireBrainContext(request, brainId, ["brain.read"]);

    const [entity, relationships] = await Promise.all([
      requireEntity(brainId, entityId),
      listRelationships({ brainId, entityId }),
    ]);

    return apiSuccess({ entity, relationships });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    type: z.enum(BRAIN_ENTITY_TYPES).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, entityId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const body = patchSchema.parse(await request.json());
    const entity = await updateEntity({ brainId, entityId, data: body });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "entity.update",
      resourceType: "brain_entity",
      resourceId: entityId,
      metadata: { fields: Object.keys(body) },
    });

    return apiSuccess({ entity });
  } catch (error) {
    return handleApiError(error);
  }
}

/** DELETE — removes the node and, by cascade, every relationship touching it. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, entityId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.delete"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const deleted = await deleteEntity(brainId, entityId);
    if (!deleted) {
      return apiError("Entity not found", 404, { code: "BRAIN_ENTITY_NOT_FOUND" });
    }

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "entity.delete",
      resourceType: "brain_entity",
      resourceId: entityId,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

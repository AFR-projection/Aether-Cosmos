import { NextRequest } from "next/server";
import { z } from "zod";
import { getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { deleteBrain, getBrainStats, updateBrain } from "@brain/application/commands/brain-service";
import { listMemories } from "@brain/application/commands/memory-service";

type RouteParams = { params: Promise<{ id: string }> };

/** GET /api/brain/[id] — the brain, its counters, and its five newest memories. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { brain } = await requireBrainContext(request, brainId, ["brain.read"]);

    const [stats, recentResult] = await Promise.all([
      getBrainStats(brainId),
      listMemories({ brainId, archived: false, limit: 5 }),
    ]);

    return apiSuccess({ brain, stats: { ...stats, recentMemories: recentResult.memories } });
  } catch (error) {
    return handleApiError(error);
  }
}

const updateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    status: z.enum(["active", "archived"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

/** PATCH /api/brain/[id] — rename, re-describe, archive or un-archive. */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { sessionUser, userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"]
    );
    await enforceBrainRateLimit(userId, "write");

    const body = updateSchema.parse(await request.json());
    const brain = await updateBrain(brainId, userId, body);

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "brain.update",
      resourceType: "brain",
      resourceId: brainId,
      metadata: { fields: Object.keys(body) },
    });
    await logActivity(sessionUser, "edit", {
      resourceType: "brain",
      resourceId: brainId,
      metadata: { action: "update", fields: Object.keys(body) },
      ip: getClientIp(request),
    });

    return apiSuccess({ brain });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * DELETE /api/brain/[id] — permanently removes the brain and everything under it
 * (memories, versions, tags, graph, audit trail) by cascade. The default brain is
 * refused; archive it instead.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { sessionUser, userId, brain } = await requireBrainContext(request, brainId, [
      "brain.delete",
    ]);
    await enforceBrainRateLimit(userId, "write");

    await deleteBrain(brainId, userId);

    await logActivity(sessionUser, "delete", {
      resourceType: "brain",
      resourceId: brainId,
      metadata: { name: brain.name },
      ip: getClientIp(request),
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

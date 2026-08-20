import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { deleteRelationship } from "@/lib/brain/graph-service";

type RouteParams = { params: Promise<{ id: string; relationshipId: string }> };

/** DELETE /api/brain/[id]/relationships/[relationshipId] — unlink two nodes. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const raw = await params;
    const brainId = requireUuid(raw.id, "id");
    const relationshipId = requireUuid(raw.relationshipId, "relationshipId");

    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.delete"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    const deleted = await deleteRelationship(brainId, relationshipId);
    if (!deleted) {
      return apiError("Relationship not found", 404, {
        code: "BRAIN_RELATIONSHIP_NOT_FOUND",
      });
    }

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "relationship.delete",
      resourceType: "brain_relationship",
      resourceId: relationshipId,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

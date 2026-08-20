import { NextRequest } from "next/server";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { unlinkMemory } from "@/lib/brain/link-service";

type RouteParams = { params: Promise<{ id: string; memoryId: string; linkId: string }> };

/**
 * DELETE /api/brain/[id]/memories/[memoryId]/links/[linkId] — removing an edge is
 * not destroying knowledge, so this sits on brain.link rather than brain.delete.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { id, linkId } = await params;
    const brainId = requireUuid(id, "id");
    const validLinkId = requireUuid(linkId, "linkId");

    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.link"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write");

    const removed = await unlinkMemory({ brainId, linkId: validLinkId });
    if (!removed) return apiError("Link not found", 404, { code: "MEMORY_LINK_NOT_FOUND" });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.unlinked",
      resourceType: "memory_link",
      resourceId: validLinkId,
      metadata: { agent: principal.agentName },
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

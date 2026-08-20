import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { publishToUser } from "@/lib/realtime/events";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { restoreMemoryVersion } from "@/lib/brain/memory-service";

type RouteParams = { params: Promise<{ id: string; memoryId: string; versionId: string }> };

const restoreSchema = z.object({ reason: z.string().trim().max(300).optional() });

/**
 * POST .../versions/[versionId]/restore — rolls the memory back to that version.
 * The rollback itself is a normal edit, so the pre-restore state is snapshotted
 * as a new version and nothing is lost.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const raw = await params;
    const brainId = requireUuid(raw.id, "id");
    const memoryId = requireUuid(raw.memoryId, "memoryId");
    const versionId = requireUuid(raw.versionId, "versionId");

    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write", 2);

    // An empty body is normal here, so tolerate a missing/invalid JSON payload.
    const payload = await request.json().catch(() => ({}));
    const body = restoreSchema.parse(payload ?? {});

    const memory = await restoreMemoryVersion({
      brainId,
      memoryId,
      versionId,
      principal: { userId, agentId: principal.agentId },
      reason: body.reason,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "memory.restore",
      resourceType: "memory",
      resourceId: memoryId,
      metadata: { versionId, reason: body.reason, agent: principal.agentName },
    });

    await publishToUser(userId, { type: "brain_memory_updated", brainId, memoryId });

    return apiSuccess({ memory });
  } catch (error) {
    return handleApiError(error);
  }
}

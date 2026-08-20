import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { publishToUser } from "@/lib/realtime/events";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { consolidateBrain } from "@/lib/brain/consolidation-service";

type RouteParams = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    /** Nothing is written unless this is explicitly true (§30). */
    apply: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .default({ apply: false });

/**
 * POST /api/brain/[id]/consolidate — find duplicate memories and contradictions.
 *
 * Dry-run by default: the caller gets the report and decides. `apply: true` archives
 * duplicates behind a surviving memory and records `contradicts` links; it never
 * deletes anything and never resolves a conflict on its own (§30, §31).
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");

    // Parsed before the auth call so we know which scope to demand: a dry run is a
    // read, applying is a bulk write that only brain.consolidate may do.
    const raw = await request.json().catch(() => ({}));
    const body = bodySchema.parse(raw ?? {});

    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      [body.apply ? "brain.consolidate" : "brain.read"],
      body.apply ? { write: true } : undefined
    );
    await enforceBrainRateLimit(userId, body.apply ? "write" : "search", body.apply ? 5 : 2);

    const report = await consolidateBrain({
      brainId,
      principal: { userId, agentId: principal.agentId },
      apply: body.apply,
      limit: body.limit,
    });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: body.apply ? "brain.consolidated" : "brain.consolidate_preview",
      resourceType: "brain",
      resourceId: brainId,
      metadata: {
        apply: body.apply,
        duplicateGroups: report.duplicates.length,
        conflicts: report.conflicts.length,
        archived: report.applied?.memoriesArchived ?? 0,
        agent: principal.agentName,
      },
    });

    if (body.apply) {
      // One event per recorded contradiction so an open UI can flag them live (§32).
      for (const pair of report.conflicts) {
        await publishToUser(userId, {
          type: "brain_conflict_detected",
          brainId,
          memoryId: pair.memoryId,
          conflictsWith: pair.conflictsWithId,
          reason: pair.reason,
        });
      }
    }

    return apiSuccess(report);
  } catch (error) {
    return handleApiError(error);
  }
}

import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { requireBrainOwnerContext } from "@/lib/brain/access";
import { requireUuid } from "@/lib/brain/http";
import { listBrainAudit } from "@/lib/brain/audit";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.date().optional(),
});

/**
 * GET /api/brain/[id]/audit — who did what to this brain, newest first.
 * Owner-only: an agent must not be able to read (or audit) its own trail.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    await requireBrainOwnerContext(request, brainId, ["brain.read"]);

    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const entries = await listBrainAudit({
      brainId,
      limit: query.limit,
      before: query.before,
    });

    return apiSuccess({ entries });
  } catch (error) {
    return handleApiError(error);
  }
}

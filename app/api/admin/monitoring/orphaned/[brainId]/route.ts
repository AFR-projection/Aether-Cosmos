/**
 * Memories old enough to have been retrieved, that never have been.
 *
 * GET /api/admin/monitoring/orphaned/:brainId?days=90
 *
 * Only `active` memories count — superseded or invalidated ones are supposed to
 * stop being retrieved. Capped at 50 rows; this is a triage list, not an export.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { getOrphanedMemories } from "@/lib/monitoring/query-analytics";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).default(90),
});

const paramsSchema = z.object({ brainId: z.string().uuid() });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ brainId: string }> }
) {
  try {
    await requireMasterOrApiKey(request, "monitoring");

    const { brainId } = paramsSchema.parse(await params);
    const { days } = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );

    const memories = await getOrphanedMemories(brainId, days);

    return apiSuccess({
      brainId,
      threshold: { days },
      count: memories.length,
      memories,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

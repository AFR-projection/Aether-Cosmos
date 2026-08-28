/**
 * Most-recalled memories in one brain.
 *
 * GET /api/admin/monitoring/top-recalled/:brainId?days=30&limit=20
 *
 * `recallCount` is how often a memory was surfaced as a candidate; `usedCount`
 * is how often it actually reached an answer. A high recall count with a low
 * used count means the memory keeps winning retrieval it should not.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { getTopRecalledMemories } from "@/lib/monitoring/query-analytics";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const paramsSchema = z.object({ brainId: z.string().uuid() });

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ brainId: string }> }
) {
  try {
    await requireMasterOrApiKey(request, "monitoring");

    const { brainId } = paramsSchema.parse(await params);
    const { days, limit } = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const memories = await getTopRecalledMemories(brainId, limit, since);

    return apiSuccess({
      brainId,
      period: { days, since },
      count: memories.length,
      memories,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * Retrieval analytics for one brain.
 *
 * GET /api/admin/monitoring/brain-analytics/:brainId?days=7
 *
 * Metrics are keyed on `query_hash`, never query text. See
 * @/shared/lib/monitoring/query-analytics.ts for what these numbers can and cannot tell
 * you — in particular, a query that matched nothing leaves no row behind, so
 * `omittedRate` (surfaced then dropped) is the honest noise signal.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getRetrievalStats } from "@/shared/lib/monitoring/query-analytics";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
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
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await getRetrievalStats(brainId, since);

    return apiSuccess({
      brainId,
      period: { days, since },
      stats: {
        totalEvents: stats.totalEvents,
        attributedEvents: stats.attributedEvents,
        uniqueQueries: stats.uniqueQueries,
        avgCandidatesPerQuery: stats.avgCandidatesPerQuery,
        omittedRate: stats.omittedRate,
        topQueryHashes: stats.topQueryHashes.slice(0, 10),
        lowRecallQueries: stats.lowRecallQueries,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

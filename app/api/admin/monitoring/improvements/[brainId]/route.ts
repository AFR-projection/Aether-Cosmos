/**
 * Suggested query-understanding improvements for one brain.
 *
 * GET /api/admin/monitoring/improvements/:brainId?days=30
 *
 * Heuristics over retrieval outcomes, not model output: each suggestion carries
 * the evidence that triggered it so an operator can judge it. An empty list is
 * the normal, healthy answer.
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { suggestQueryImprovements } from "@/lib/monitoring/query-analytics";

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
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

    const improvements = await suggestQueryImprovements(brainId, since);

    return apiSuccess({
      brainId,
      period: { days, since },
      count: improvements.length,
      improvements,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

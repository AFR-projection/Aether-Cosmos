/**
 * Brain Analytics API Route
 *
 * GET /api/admin/monitoring/brain-analytics/:brainId
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getRetrievalStats } from "@/lib/monitoring/query-analytics";

async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { brainId: string } }
) {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const { brainId } = params;
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get("days") ?? "7", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const stats = await getRetrievalStats(brainId, since);

    return NextResponse.json({
      brainId,
      period: { days, since },
      stats: {
        totalQueries: stats.totalQueries,
        uniqueQueries: stats.uniqueQueries,
        avgCandidatesPerQuery: stats.avgCandidatesPerQuery,
        zeroResultRate: stats.zeroResultRate,
        topQueryHashes: stats.topQueryHashes.slice(0, 10), // limit for API
        lowRecallQueries: stats.lowRecallQueries,
      },
    });
  } catch (error) {
    console.error("Brain analytics failed:", error);
    return NextResponse.json(
      { error: "Analytics failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

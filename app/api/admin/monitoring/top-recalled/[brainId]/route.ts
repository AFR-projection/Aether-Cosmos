/**
 * Top Recalled Memories API Route
 *
 * GET /api/admin/monitoring/top-recalled/:brainId
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getTopRecalledMemories } from "@/lib/monitoring/query-analytics";

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
    const limit = parseInt(url.searchParams.get("limit") ?? "20", 10);
    const days = parseInt(url.searchParams.get("days") ?? "30", 10);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const memories = await getTopRecalledMemories(brainId, limit, since);

    return NextResponse.json({
      brainId,
      period: { days, since },
      memories,
    });
  } catch (error) {
    console.error("Top recalled query failed:", error);
    return NextResponse.json(
      { error: "Query failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

/**
 * Orphaned Memories API Route
 *
 * GET /api/admin/monitoring/orphaned/:brainId
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getOrphanedMemories } from "@/lib/monitoring/query-analytics";

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
    const days = parseInt(url.searchParams.get("days") ?? "90", 10);

    const memories = await getOrphanedMemories(brainId, days);

    return NextResponse.json({
      brainId,
      threshold: { days },
      count: memories.length,
      memories,
    });
  } catch (error) {
    console.error("Orphaned memories query failed:", error);
    return NextResponse.json(
      { error: "Query failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

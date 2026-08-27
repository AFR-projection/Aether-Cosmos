/**
 * Admin Monitoring API Routes
 *
 * GET /api/admin/monitoring/health - Current system health
 * GET /api/admin/monitoring/brain-analytics/:brainId - Query analytics for a brain
 * GET /api/admin/monitoring/top-recalled/:brainId - Most recalled memories
 * GET /api/admin/monitoring/orphaned/:brainId - Never-recalled memories
 * GET /api/admin/monitoring/improvements/:brainId - Suggested query improvements
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import {
  runHealthChecks,
  type HealthReport,
} from "@/lib/monitoring/health-monitor";
import {
  getRetrievalStats,
  suggestQueryImprovements,
  getTopRecalledMemories,
  getOrphanedMemories,
  type RetrievalStats,
  type QueryImprovement,
  type MemoryRecallStats,
} from "@/lib/monitoring/query-analytics";

/**
 * Check if user is admin.
 */
async function requireAdmin() {
  const user = await getCurrentUser();
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return null;
}

/**
 * GET /api/admin/monitoring/health
 */
export async function GET(request: NextRequest) {
  const authError = await requireAdmin();
  if (authError) return authError;

  try {
    const report: HealthReport = await runHealthChecks();

    return NextResponse.json({
      status: report.overall,
      timestamp: report.timestamp,
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        message: check.message,
        details: check.details,
      })),
    });
  } catch (error) {
    console.error("Health check failed:", error);
    return NextResponse.json(
      { error: "Health check failed", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

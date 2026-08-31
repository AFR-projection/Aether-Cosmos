/**
 * System health endpoint.
 *
 * GET /api/admin/monitoring/health
 *
 * Runs every health check (database, redis, R2, email senders, brain health,
 * host memory) and returns the aggregate. The HTTP status stays 200 even when
 * the system is unhealthy — the caller is asking "what is the state?", and a
 * 5xx here would be indistinguishable from the endpoint itself being broken.
 */

import { NextRequest } from "next/server";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { runHealthChecks } from "@/shared/lib/monitoring/health-monitor";

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "monitoring");

    const report = await runHealthChecks();

    return apiSuccess({
      status: report.overall,
      timestamp: report.timestamp,
      checks: report.checks.map((check) => ({
        name: check.name,
        status: check.status,
        message: check.message,
        details: check.details ?? null,
      })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

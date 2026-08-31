import { NextRequest } from "next/server";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { getRecentEmailLogs } from "@/shared/infrastructure/email/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Recent email activity (send/verify/OTP), most-recent-first. Backed by an
 * in-memory ring buffer, so it reflects THIS app process only and resets on
 * restart — a live diagnostic tail, not a persisted audit log. Master-only.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "email");
    const limitParam = Number(request.nextUrl.searchParams.get("limit"));
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;
    return apiSuccess({ entries: getRecentEmailLogs(limit) });
  } catch (error) {
    return handleApiError(error);
  }
}

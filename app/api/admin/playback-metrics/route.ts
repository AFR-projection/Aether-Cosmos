import { NextRequest } from "next/server";
import { requireMaster } from "@/shared/lib/auth/session";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { playbackTelemetrySnapshot } from "@/shared/lib/monitoring/playback-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Aggregated playback health, master only.
 *
 * Read-only over the in-process ring, so it is cheap and it touches no database. The window is
 * a query parameter because the two questions are different: "is something wrong right now"
 * wants minutes, "did the change help" wants hours.
 */
export async function GET(request: NextRequest) {
  try {
    await requireMaster();
    const raw = Number(request.nextUrl.searchParams.get("windowMinutes"));
    const windowMinutes =
      Number.isFinite(raw) && raw > 0 ? Math.min(1440, raw) : 60;
    return apiSuccess(playbackTelemetrySnapshot(windowMinutes * 60_000));
  } catch (error) {
    return handleApiError(error);
  }
}

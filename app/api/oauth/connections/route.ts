import { NextRequest } from "next/server";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { listConnectedApps } from "@/shared/lib/auth/oauth/tokens";
import { apiSuccess, handleApiError } from "@/shared/api/response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth();
    void getClientIp(request);
    const apps = await listConnectedApps(user.id);
    return apiSuccess({ apps });
  } catch (error) {
    return handleApiError(error);
  }
}

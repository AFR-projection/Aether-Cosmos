import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { deletionJobs } from "@/shared/infrastructure/db/schema";
import { requireAuthOrApiKey } from "@/shared/lib/auth/api-key";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await requireAuthOrApiKey(request, ["delete"]);
    const { id } = await params;
    const [job] = await db
      .select()
      .from(deletionJobs)
      .where(and(eq(deletionJobs.id, id), eq(deletionJobs.userId, getEffectiveUserId(sessionUser))))
      .limit(1);
    if (!job) return apiError("Deletion job not found", 404);
    return apiSuccess({ job });
  } catch (error) {
    return handleApiError(error);
  }
}

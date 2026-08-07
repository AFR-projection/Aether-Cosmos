import { NextRequest } from "next/server";
import { count } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { requireMasterOrApiKey } from "@/lib/auth/api-key";
import { validateCsrf } from "@/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import {
  getAdminSettings,
  updateAdminSettings,
  type AdminSettings,
} from "@/lib/admin-settings";
import { readCleanupState } from "@/lib/system/cleanup-state";

export type { AdminSettings };

function parseInactivityMs(): number | null {
  const raw = process.env.SESSION_INACTIVITY_MS;
  if (!raw) return null;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

const patchSchema = z
  .object({
    maintenanceMode: z.boolean().optional(),
    maintenanceMessage: z.string().max(500).optional(),
    defaultQuotaGB: z.number().optional(),
    maxUploadSizeMB: z.number().optional(),
    allowedMimeTypes: z.array(z.string()).optional(),
    blockedExtensions: z.array(z.string()).optional(),
    sessionDurationHours: z.number().optional(),
    maxSessionsPerUser: z.number().optional(),
    registrationEnabled: z.boolean().optional(),
    maxFileLifetimeDays: z.number().optional(),
    storageWarningThreshold: z.number().optional(),
    autoDeleteTrashDays: z.number().optional(),
    rateLimitPerMinute: z.number().optional(),
    logRetentionDays: z.number().optional(),
    stepCodeRequired: z.boolean().optional(),
    emailDailyLimitPerSender: z.number().optional(),
    emailFailureThreshold: z.number().optional(),
    emailCooldownMinutes: z.number().optional(),
  })
  .strip();

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "settings");
    const settings = await getAdminSettings(true);
    const [[userCount], cleanup] = await Promise.all([
      db.select({ count: count() }).from(users),
      readCleanupState(db).catch(() => null),
    ]);

    return apiSuccess({
      ...settings,
      _meta: {
        totalUsers: userCount.count,
        version: "1.0.0",
        persistence: "database",
        cacheTtlSeconds: 30,
        cleanup,
        // Idle expiry is opt-in via env; the UI warns when it is shorter than
        // the configured session duration, since the shorter one wins.
        sessionInactivityMs: parseInactivityMs(),
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const body = patchSchema.parse(await request.json());
    const updated = await updateAdminSettings(body);

    return apiSuccess(updated);
  } catch (error) {
    return handleApiError(error);
  }
}

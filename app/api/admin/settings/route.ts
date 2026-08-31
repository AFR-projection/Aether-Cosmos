import { NextRequest } from "next/server";
import { count } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import {
  getAdminSettings,
  updateAdminSettings,
  type AdminSettings,
} from "@/shared/lib/settings/admin-settings";
import { readCleanupState } from "@/shared/lib/system/cleanup-state";

export type { AdminSettings };

/*
 * Every key here is optional and the object is `.strip()`ed, so a client can PATCH
 * one field without resending the rest and cannot smuggle in an unknown key.
 * Ranges are deliberately NOT enforced here — `normalizeSettings` in
 * @/shared/lib/settings/admin-settings.ts clamps every field on the way in, which is the one place
 * that also protects writes coming from anywhere else.
 */
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
    sessionIdleTimeoutMinutes: z.number().optional(),
    sessionIpBinding: z.enum(["auto", "on", "off"]).optional(),
    loginMaxAttempts: z.number().optional(),
    loginIpMaxAttempts: z.number().optional(),
    loginLockoutMinutes: z.number().optional(),
    uploadUrlExpiryMinutes: z.number().optional(),
    downloadUrlExpirySeconds: z.number().optional(),
    defaultBandwidthQuotaGB: z.number().optional(),
    // Bounded so a paste cannot turn the allowlist into an unbounded blob.
    allowedEmailDomains: z.array(z.string().max(253)).max(100).optional(),
    publicSharingEnabled: z.boolean().optional(),
    shareDefaultExpiryDays: z.number().optional(),
    shareMaxExpiryDays: z.number().optional(),
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
        // Whether "auto" IP binding resolves to on or off here. The panel shows
        // the resolved answer so "auto" is not a mystery to whoever picked it.
        productionMode: process.env.NODE_ENV === "production",
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

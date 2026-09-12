import { NextRequest } from "next/server";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { db } from "@/shared/infrastructure/db";
import { encryptSecret } from "@/shared/infrastructure/email/crypto";
import {
  subtitlePipelineRuns,
  subtitlePipelineWorkItems,
  subtitleProviderProfiles,
  subtitleReconciliationState,
} from "@/shared/infrastructure/db/schema";
import {
  getPublicSubtitleConfig,
  updateSubtitleConfig,
} from "@files/infrastructure/subtitles/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const capabilitySchema = z.enum(["asr", "translation"]);
const roleSchema = z.enum(["primary", "fallback"]);
const healthSchema = z.enum(["unknown", "healthy", "degraded", "unhealthy"]);

const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, "Must be an https URL (http is allowed only for loopback)");

const legacyUpdateSchema = z.object({
  provider: z.string().trim().min(1).max(60).optional(),
  baseUrl: baseUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  translateBaseUrl: baseUrlSchema.optional(),
  translateModel: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  apiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
  translateApiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
}).strict();

const profileUpdateSchema = z.object({
  capability: capabilitySchema,
  role: roleSchema,
  name: z.string().trim().min(1).max(120).optional(),
  provider: z.string().trim().min(1).max(60).optional(),
  baseUrl: baseUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().min(1_000).max(600_000).optional(),
  concurrencyLimit: z.number().int().min(1).max(100).optional(),
  rateLimit: z.number().int().min(0).max(100_000).optional(),
  burstLimit: z.number().int().min(0).max(100_000).optional(),
  apiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
}).strict();

const advancedUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  profiles: z.array(profileUpdateSchema).min(1).max(4),
}).strict();

type ProfileRow = typeof subtitleProviderProfiles.$inferSelect;
type PublicProfile = Omit<ProfileRow, "apiKeyEncrypted"> & { hasApiKey: boolean };

type OperationalStatus = {
  available: boolean;
  activeRuns: number;
  pendingWorkItems: number;
  leasedWorkItems: number;
  failedRuns: number;
  backfill: {
    status: "idle" | "running" | "blocked" | "failed";
    scannedCount: number;
    processedCount: number;
    failedCount: number;
    heartbeatAt: string | null;
    lastCompletedAt: string | null;
    lastErrorCode: string | null;
  } | null;
};

function publicProfile(row: ProfileRow): PublicProfile {
  const { apiKeyEncrypted, ...profile } = row;
  return { ...profile, hasApiKey: Boolean(apiKeyEncrypted) };
}

async function listProfiles(): Promise<PublicProfile[]> {
  return (await db.select().from(subtitleProviderProfiles)).map(publicProfile);
}

async function getOperationalStatus(): Promise<OperationalStatus> {
  try {
    const [runCounts, workCounts, [backfill]] = await Promise.all([
      db
        .select({
          active: sql<number>`count(*) filter (where ${subtitlePipelineRuns.status} in ('queued', 'running', 'blocked'))::int`,
          failed: sql<number>`count(*) filter (where ${subtitlePipelineRuns.status} = 'failed')::int`,
        })
        .from(subtitlePipelineRuns),
      db
        .select({
          pending: sql<number>`count(*) filter (where ${subtitlePipelineWorkItems.status} in ('pending', 'retry'))::int`,
          leased: sql<number>`count(*) filter (where ${subtitlePipelineWorkItems.status} = 'leased')::int`,
        })
        .from(subtitlePipelineWorkItems),
      db
        .select()
        .from(subtitleReconciliationState)
        .where(eq(subtitleReconciliationState.kind, "library_backfill"))
        .limit(1),
    ]);
    return {
      available: true,
      activeRuns: Number(runCounts[0]?.active ?? 0),
      pendingWorkItems: Number(workCounts[0]?.pending ?? 0),
      leasedWorkItems: Number(workCounts[0]?.leased ?? 0),
      failedRuns: Number(runCounts[0]?.failed ?? 0),
      backfill: backfill
        ? {
            status: backfill.status,
            scannedCount: backfill.scannedCount,
            processedCount: backfill.processedCount,
            failedCount: backfill.failedCount,
            heartbeatAt: backfill.heartbeatAt?.toISOString() ?? null,
            lastCompletedAt: backfill.lastCompletedAt?.toISOString() ?? null,
            lastErrorCode: backfill.lastErrorCode,
          }
        : null,
    };
  } catch {
    return {
      available: false,
      activeRuns: 0,
      pendingWorkItems: 0,
      leasedWorkItems: 0,
      failedRuns: 0,
      backfill: null,
    };
  }
}

async function getAdvancedConfig() {
  try {
    const [profiles, operational] = await Promise.all([listProfiles(), getOperationalStatus()]);
    return { available: profiles.length > 0, profiles, operational };
  } catch {
    return {
      available: false,
      profiles: [] as PublicProfile[],
      operational: await getOperationalStatus(),
    };
  }
}

function legacyUpdateForProfiles(profiles: z.infer<typeof profileUpdateSchema>[]) {
  const asr = profiles.find((profile) => profile.capability === "asr" && profile.role === "primary");
  const translation = profiles.find(
    (profile) => profile.capability === "translation" && profile.role === "primary"
  );
  return {
    ...(asr?.provider !== undefined ? { provider: asr.provider } : {}),
    ...(asr?.baseUrl !== undefined ? { baseUrl: asr.baseUrl } : {}),
    ...(asr?.model !== undefined ? { model: asr.model } : {}),
    ...(asr?.apiKey !== undefined ? { apiKey: asr.apiKey } : {}),
    ...(translation?.baseUrl !== undefined ? { translateBaseUrl: translation.baseUrl } : {}),
    ...(translation?.model !== undefined ? { translateModel: translation.model } : {}),
    ...(translation?.apiKey !== undefined ? { translateApiKey: translation.apiKey } : {}),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "settings");
    const legacy = await getPublicSubtitleConfig();
    const advanced = await getAdvancedConfig();
    return apiSuccess({ ...legacy, advanced });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const body: unknown = await request.json();
    const advancedParsed = advancedUpdateSchema.safeParse(body);
    if (!advancedParsed.success) {
      const update = legacyUpdateSchema.parse(body);
      return apiSuccess(await updateSubtitleConfig(update));
    }

    const { enabled, profiles } = advancedParsed.data;
    const existing = await db
      .select()
      .from(subtitleProviderProfiles)
      .where(
        inArray(
          subtitleProviderProfiles.capability,
          [...new Set(profiles.map((profile) => profile.capability))]
        )
      );

    await db.transaction(async (tx) => {
      for (const profile of profiles) {
        const current = existing.find(
          (row) => row.capability === profile.capability && row.role === profile.role
        );
        const now = new Date();
        const values = {
          name: profile.name ?? current?.name ?? `${profile.capability} ${profile.role}`,
          provider: profile.provider ?? current?.provider ?? "openai-compatible",
          baseUrl: profile.baseUrl ?? current?.baseUrl ?? "https://api.openai.com/v1",
          model: profile.model ?? current?.model ?? "",
          enabled: profile.enabled ?? current?.enabled ?? false,
          timeoutMs: profile.timeoutMs ?? current?.timeoutMs ?? 120_000,
          concurrencyLimit: profile.concurrencyLimit ?? current?.concurrencyLimit ?? 1,
          rateLimit: profile.rateLimit ?? current?.rateLimit ?? 0,
          burstLimit: profile.burstLimit ?? current?.burstLimit ?? 0,
          ...(profile.apiKey !== undefined
            ? {
                apiKeyEncrypted:
                  profile.apiKey === null ? null : encryptSecret(profile.apiKey),
              }
            : {}),
          updatedAt: now,
        };
        await tx
          .insert(subtitleProviderProfiles)
          .values({ capability: profile.capability, role: profile.role, ...values })
          .onConflictDoUpdate({
            target: [subtitleProviderProfiles.capability, subtitleProviderProfiles.role],
            set: values,
          });
      }
    });

    await updateSubtitleConfig({
      ...(enabled !== undefined ? { enabled } : {}),
      ...legacyUpdateForProfiles(profiles),
    });
    const legacy = await getPublicSubtitleConfig();
    return apiSuccess({ ...legacy, advanced: await getAdvancedConfig() });
  } catch (error) {
    return handleApiError(error);
  }
}

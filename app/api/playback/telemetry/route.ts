import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/shared/lib/auth/session";
import { validateCsrf } from "@/shared/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import { recordPlaybackSession } from "@/shared/lib/monitoring/playback-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One report per finished viewing, from the player.
 *
 * Authenticated only, and that is a deliberate limit rather than an oversight: making this
 * public would add an anonymous write endpoint whose only purpose is diagnostics, and a bounded
 * ring buffer full of made-up numbers is worse than an empty one. Share-link playback therefore
 * reports nothing — see docs/playback-architecture.md, "What is not measured".
 *
 * Every field is bounded by the schema below, because the values arrive from a browser and the
 * snapshot computes percentiles over them: one `Infinity` would make the whole window useless.
 *
 * What is deliberately NOT accepted here, and must never be added: the presigned URL, the share
 * token, an IP address, the user-agent string, or anything read out of the media itself.
 */
const MAX_MS = 24 * 60 * 60 * 1000;

const reportSchema = z.object({
  fileId: z.string().uuid().nullish(),
  source: z.enum(["direct_r2", "legacy_proxy", "encrypted_blob"]),
  urlLatencyMs: z.number().min(0).max(MAX_MS).nullish(),
  startupMs: z.number().min(0).max(MAX_MS).nullish(),
  watchedMs: z.number().min(0).max(MAX_MS),
  rebufferCount: z.number().int().min(0).max(100_000),
  rebufferMs: z.number().min(0).max(MAX_MS),
  seekCount: z.number().int().min(0).max(100_000),
  refreshCount: z.number().int().min(0).max(1_000),
  errorCode: z.string().max(48).nullish(),
  videoWidth: z.number().int().min(0).max(16_384).nullish(),
  videoHeight: z.number().int().min(0).max(16_384).nullish(),
  durationSeconds: z
    .number()
    .min(0)
    .max(86_400 * 7)
    .nullish(),
  /** Coarse family the client already reduced ("chrome", "safari", …). */
  platform: z.string().max(24).nullish(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request)))
      return apiError("Invalid CSRF token", 403);
    await requireAuth();

    const report = reportSchema.parse(await request.json());

    recordPlaybackSession({
      surface: "file",
      source: report.source,
      fileId: report.fileId ?? null,
      urlLatencyMs: report.urlLatencyMs ?? null,
      startupMs: report.startupMs ?? null,
      watchedMs: report.watchedMs,
      rebufferCount: report.rebufferCount,
      rebufferMs: report.rebufferMs,
      seekCount: report.seekCount,
      refreshCount: report.refreshCount,
      errorCode: report.errorCode ?? null,
      videoWidth: report.videoWidth ?? null,
      videoHeight: report.videoHeight ?? null,
      durationSeconds: report.durationSeconds ?? null,
      platform: report.platform ?? null,
    });

    return apiSuccess({ recorded: true });
  } catch (error) {
    return handleApiError(error);
  }
}

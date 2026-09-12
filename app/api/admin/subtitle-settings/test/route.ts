import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { db } from "@/shared/infrastructure/db";
import { subtitleProviderProfiles } from "@/shared/infrastructure/db/schema";
import { PROBE_WAV } from "@files/domain/services/subtitles/probe-audio";
import { loadSubtitleConfig } from "@files/infrastructure/subtitles/config";
import {
  OpenAiCompatibleTranscriber,
  SubtitleTranscriptionError,
} from "@files/infrastructure/subtitles/transcriber";
import {
  ChatCompletionTranslator,
  SubtitleTranslationError,
} from "@files/infrastructure/subtitles/translator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({
  target: z.enum(["transcribe", "translate"]),
  role: z.enum(["primary", "fallback"]).optional(),
}).strict();

function describe(error: unknown): { message: string; status?: number } {
  if (error instanceof SubtitleTranscriptionError || error instanceof SubtitleTranslationError) {
    return { message: error.message.slice(0, 300), status: error.status };
  }
  return { message: error instanceof Error ? error.message.slice(0, 300) : "Unknown failure" };
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const { target, role } = testSchema.parse(await request.json());
    let profile:
      | {
          id: string;
          capability: "asr" | "translation";
          role: "primary" | "fallback";
          baseUrl: string;
          model: string;
          apiKeyEncrypted: string | null;
          timeoutMs: number;
        }
      | undefined;

    if (role) {
      const capability = target === "transcribe" ? "asr" : "translation";
      [profile] = await db
        .select({
          id: subtitleProviderProfiles.id,
          capability: subtitleProviderProfiles.capability,
          role: subtitleProviderProfiles.role,
          baseUrl: subtitleProviderProfiles.baseUrl,
          model: subtitleProviderProfiles.model,
          apiKeyEncrypted: subtitleProviderProfiles.apiKeyEncrypted,
          timeoutMs: subtitleProviderProfiles.timeoutMs,
        })
        .from(subtitleProviderProfiles)
        .where(
          and(
            eq(subtitleProviderProfiles.capability, capability),
            eq(subtitleProviderProfiles.role, role)
          )
        )
        .limit(1);
      if (!profile) return apiError("That provider profile is not configured", 404);
    }

    const config = await loadSubtitleConfig(undefined, true);
    const apiKey = profile
      ? await decryptProfileKey(profile.apiKeyEncrypted)
      : target === "transcribe"
        ? config.apiKey
        : config.translateApiKey;
    const baseUrl = profile?.baseUrl ??
      (target === "transcribe" ? config.baseUrl : config.translateBaseUrl);
    const model = profile?.model ??
      (target === "transcribe" ? config.model : config.translateModel);
    const timeoutMs = Math.min(profile?.timeoutMs ?? 30_000, 30_000);

    if (!apiKey) return apiError(`Store a ${target === "transcribe" ? "transcription" : "translation"} key first`, 400, { code: "SUBTITLE_NO_KEY" });

    const startedAt = Date.now();
    let result: { ok: boolean; model: string; message?: string; status?: number };
    if (target === "transcribe") {
      const transcriber = new OpenAiCompatibleTranscriber({ apiKey, baseUrl, model, timeoutMs });
      try {
        await transcriber.transcribe({
          audio: PROBE_WAV.bytes,
          fileName: PROBE_WAV.fileName,
          mimeType: PROBE_WAV.mimeType,
          language: "en",
        });
        result = { ok: true, model };
      } catch (error) {
        result = { ok: false, model, ...describe(error) };
      }
    } else {
      const translator = new ChatCompletionTranslator({ apiKey, baseUrl, model, timeoutMs });
      try {
        const reply = await translator.complete({
          system: 'Reply with JSON only: [{"n":1,"text":"…"}]',
          user: "TRANSLATE THESE 1 LINES:\n1. Hello\n\nReturn exactly 1 numbered translation into Indonesian.",
        });
        result = {
          ok: reply.trim().length > 0,
          model,
          ...(reply.trim().length === 0 ? { message: "The model returned nothing" } : {}),
        };
      } catch (error) {
        result = { ok: false, model, ...describe(error) };
      }
    }

    if (profile) {
      await db
        .update(subtitleProviderProfiles)
        .set({
          health: result.ok ? "healthy" : "unhealthy",
          lastHealthAt: new Date(),
          lastErrorCode: result.ok ? null : String(result.status ?? "PROBE_FAILED"),
          consecutiveFailures: result.ok ? 0 : 1,
          updatedAt: new Date(),
        })
        .where(eq(subtitleProviderProfiles.id, profile.id));
    }
    return apiSuccess({ ...result, latencyMs: Date.now() - startedAt });
  } catch (error) {
    return handleApiError(error);
  }
}

async function decryptProfileKey(ciphertext: string | null): Promise<string | null> {
  if (!ciphertext) return null;
  try {
    const { decryptSecret } = await import("@/shared/infrastructure/email/crypto");
    return decryptSecret(ciphertext);
  } catch {
    return null;
  }
}

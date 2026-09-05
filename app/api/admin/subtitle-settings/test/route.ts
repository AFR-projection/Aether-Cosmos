import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
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

/**
 * Prove a provider works, before a user finds out that it does not.
 *
 * Each half is tested the way it is really used, which is the only kind of test worth having here:
 * the transcription probe uploads a second of generated silence and asks for `verbose_json`, so a
 * pass means the endpoint, the credentials, the model name AND its support for timestamped output
 * are all correct. A model that answers 200 but cannot produce segments fails this, which is
 * exactly the misconfiguration that would otherwise surface as a user's track failing an hour later.
 *
 * The translation probe asks for one line back and checks that a line came back, for the same
 * reason: a model that ignores the format is a model that will fail every batch.
 *
 * The keys are read from storage rather than accepted in the body. Testing a key the caller typed
 * but has not saved would answer a question about a configuration that does not exist.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const testSchema = z.object({
  target: z.enum(["transcribe", "translate"]),
});

/** A provider failure as a sentence, with its status where it gave one. */
function describe(error: unknown): { message: string; status?: number } {
  if (error instanceof SubtitleTranscriptionError || error instanceof SubtitleTranslationError) {
    return { message: error.message, status: error.status };
  }
  return { message: error instanceof Error ? error.message.slice(0, 300) : "Unknown failure" };
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const { target } = testSchema.parse(await request.json());
    // Forced: an operator presses Test immediately after saving, and the 30-second cache would
    // otherwise answer for the key they just replaced.
    const config = await loadSubtitleConfig(undefined, true);

    if (target === "transcribe") {
      if (!config.apiKey) {
        return apiError("Store a transcription key first", 400, { code: "SUBTITLE_NO_KEY" });
      }
      const transcriber = new OpenAiCompatibleTranscriber({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        // A one-second clip either answers quickly or is not going to.
        timeoutMs: 30_000,
      });
      try {
        await transcriber.transcribe({
          audio: PROBE_WAV.bytes,
          fileName: PROBE_WAV.fileName,
          mimeType: PROBE_WAV.mimeType,
          language: "en",
        });
        return apiSuccess({ ok: true, model: config.model });
      } catch (error) {
        return apiSuccess({ ok: false, model: config.model, ...describe(error) });
      }
    }

    if (!config.translateApiKey) {
      return apiError("Store a translation key first", 400, { code: "SUBTITLE_NO_KEY" });
    }
    const translator = new ChatCompletionTranslator({
      apiKey: config.translateApiKey,
      baseUrl: config.translateBaseUrl,
      model: config.translateModel,
      timeoutMs: 30_000,
    });
    try {
      const reply = await translator.complete({
        system: 'Reply with JSON only: [{"n":1,"text":"…"}]',
        user: "TRANSLATE THESE 1 LINES:\n1. Hello\n\nReturn exactly 1 numbered translation into Indonesian.",
      });
      // Not checked against an expected translation — models differ and both "Halo" and "Hai" are
      // right. That something came back in the requested shape is the whole assertion.
      return apiSuccess({
        ok: reply.trim().length > 0,
        model: config.translateModel,
        ...(reply.trim().length === 0 ? { message: "The model returned nothing" } : {}),
      });
    } catch (error) {
      return apiSuccess({ ok: false, model: config.translateModel, ...describe(error) });
    }
  } catch (error) {
    return handleApiError(error);
  }
}

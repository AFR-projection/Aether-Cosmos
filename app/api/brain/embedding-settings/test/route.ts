import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { loadEmbeddingConfig } from "@brain/infrastructure/providers/config";
import { detectEmbeddingDimension } from "@brain/infrastructure/providers/detect";
import { OpenRouterEmbeddingError } from "@brain/infrastructure/providers/openrouter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live connectivity + dimension check for the embedding provider (P9).
 *
 * Master-gated like the config write. It embeds a tiny fixed sample and REPORTS the width
 * the model actually produces, so an operator learns HERE — not three days into a
 * backfill — what a model outputs and whether the key works. There is no expected width:
 * every OpenRouter model has its own, and the detected value is what Save then stores.
 * The key is never echoed back; only `{ok, model, dimensions}` or `{ok:false, error}`.
 *
 * The key under test is either the one just typed (so it can be validated before saving)
 * or, when the field was left blank, the stored one. Errors are returned as `{ok:false}`
 * with a 200 so the client can render them inline rather than as a thrown request.
 */
const testSchema = z.object({
  apiKey: z.string().trim().min(1).max(400).optional(),
  model: z.string().trim().min(1).max(200).optional(),
});

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request)))
      return apiSuccess({ ok: false, error: "Invalid CSRF token" });
    await requireMasterOrApiKey(request, "settings");

    const body = testSchema.parse(await request.json());
    const stored = await loadEmbeddingConfig(undefined, true);

    const apiKey = body.apiKey ?? stored.apiKey ?? "";
    const model = body.model ?? stored.model;
    if (apiKey.trim().length === 0) {
      return apiSuccess({ ok: false, error: "No API key configured to test" });
    }

    try {
      const dimensions = await detectEmbeddingDimension({ apiKey, model });
      if (!dimensions || dimensions <= 0) {
        return apiSuccess({
          ok: false,
          model,
          error: `Model "${model}" returned an empty vector`,
        });
      }
      return apiSuccess({ ok: true, model, dimensions });
    } catch (err) {
      const message =
        err instanceof OpenRouterEmbeddingError || err instanceof Error
          ? err.message
          : "Embedding test failed";
      return apiSuccess({ ok: false, model, error: message });
    }
  } catch (error) {
    return handleApiError(error);
  }
}

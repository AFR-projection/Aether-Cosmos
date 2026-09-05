import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import {
  getPublicSubtitleConfig,
  updateSubtitleConfig,
} from "@files/infrastructure/subtitles/config";

/**
 * The instance's subtitle provider configuration.
 *
 * Two SERVER-WIDE secrets with a real per-use cost and a privacy tradeoff — a video's audio and its
 * dialogue leave this server — so writes are gated behind master auth exactly like the Gmail sender
 * config, not behind ownership of any file. A regular user cannot spend the operator's budget or
 * change where the audio goes.
 *
 * Neither key is ever returned. GET yields only whether each one exists.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A base URL is accepted rather than a vendor name, because "OpenAI-compatible" is the actual
 * contract — restricting it to a list of hosts would block the next provider that implements the
 * same two endpoints for less money.
 *
 * `https` only, and that is not negotiable: an API key in an `Authorization` header over plain HTTP
 * is a key on the wire. Loopback is allowed so an operator can point this at a local proxy.
 */
const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(400)
  .refine((value) => {
    try {
      const url = new URL(value);
      if (url.protocol === "https:") return true;
      return (
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
      );
    } catch {
      return false;
    }
  }, "Must be an https URL (http is allowed only for loopback)");

const updateSchema = z.object({
  provider: z.string().trim().min(1).max(60).optional(),
  baseUrl: baseUrlSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  translateBaseUrl: baseUrlSchema.optional(),
  translateModel: z.string().trim().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  /**
   * A non-empty string sets a new key; `null` explicitly clears it; omitting the field leaves the
   * stored key untouched — so flipping `enabled` need not resend either secret.
   */
  apiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
  translateApiKey: z.union([z.string().trim().min(1).max(400), z.null()]).optional(),
});

export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "settings");
    return apiSuccess(await getPublicSubtitleConfig());
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    await requireMasterOrApiKey(request, "settings");

    const update = updateSchema.parse(await request.json());
    return apiSuccess(await updateSubtitleConfig(update));
  } catch (error) {
    return handleApiError(error);
  }
}

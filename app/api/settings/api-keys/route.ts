import { NextRequest } from "next/server";
import { z } from "zod";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { getEffectiveUserId } from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import {
  API_KEY_SCOPES,
  API_KEY_PRESETS,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  normalizeApiKeyScopes,
  type ApiKeyScope,
  type ApiKeyPreset,
} from "@/shared/lib/auth/api-key";
import { buildApiV1Docs } from "@/shared/api/v1-docs";

export async function GET() {
  try {
    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const keys = await listApiKeys(userId);
    return apiSuccess({
      keys,
      presets: API_KEY_PRESETS,
      scopes: API_KEY_SCOPES,
      docs: buildApiV1Docs(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const scopeEnum = z.enum(["read", "upload", "download", "delete", "write", "full"]);

const createSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    scopes: z.array(scopeEnum).min(1).optional(),
    preset: z.enum(["ai_agent", "read_only", "upload_bot", "full_access"]).optional(),
    expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .refine((body) => body.preset || (body.name && body.scopes?.length), {
    message: "Provide a preset or both name and scopes",
  });

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const body = createSchema.parse(await request.json());
    const ip = getClientIp(request);

    let name: string;
    let scopes: ApiKeyScope[];
    let expiresAt: Date | null = null;

    if (body.preset) {
      const preset = API_KEY_PRESETS[body.preset as ApiKeyPreset];
      name = body.name?.trim() || preset.name;
      scopes = [...preset.scopes];
      const days = body.expiresInDays ?? preset.expiresInDays;
      expiresAt = days ? new Date(Date.now() + days * 86400000) : null;
    } else {
      name = body.name!.trim();
      scopes = normalizeApiKeyScopes(body.scopes ?? []);
      if (scopes.length === 0) return apiError("At least one valid scope required", 400);
      expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86400000)
        : null;
    }

    const key = await createApiKey(userId, name, scopes, expiresAt);

    await logActivity(sessionUser, "edit", {
      resourceType: "api_key",
      resourceId: key.id,
      metadata: { action: "create", name: key.name, scopes: key.scopes },
      ip,
    });

    return apiSuccess({
      key: {
        id: key.id,
        name: key.name,
        keyPrefix: key.keyPrefix,
        scopes: key.scopes,
        expiresAt: key.expiresAt,
        createdAt: key.createdAt,
        rawKey: key.rawKey,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const deleteSchema = z.object({
  id: z.string().uuid(),
});

export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const { id } = deleteSchema.parse(await request.json());
    const ip = getClientIp(request);

    const ok = await deleteApiKey(userId, id);
    if (!ok) return apiError("API key not found", 404);

    await logActivity(sessionUser, "edit", {
      resourceType: "api_key",
      resourceId: id,
      metadata: { action: "revoke" },
      ip,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

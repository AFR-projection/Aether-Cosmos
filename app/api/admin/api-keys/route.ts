import { NextRequest } from "next/server";
import { z } from "zod";
import { requireMaster, getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import {
  MASTER_API_KEY_PRESETS,
  MASTER_API_KEY_SCOPES,
  MASTER_SCOPE_LABELS,
  MAX_MASTER_API_KEYS,
  createMasterApiKey,
  deleteMasterApiKey,
  listMasterApiKeys,
  normalizeMasterApiKeyScopes,
  type MasterApiKeyPreset,
  type MasterApiKeyScope,
} from "@/shared/lib/auth/api-key";
import { buildMasterApiDocs } from "@/shared/api/master-v1-docs";

export async function GET() {
  try {
    const master = await requireMaster();
    const keys = await listMasterApiKeys(master.id);
    return apiSuccess({
      keys,
      presets: MASTER_API_KEY_PRESETS,
      scopes: MASTER_API_KEY_SCOPES,
      scopeLabels: MASTER_SCOPE_LABELS,
      maxKeys: MAX_MASTER_API_KEYS,
      docs: buildMasterApiDocs(),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const masterScopeEnum = z.enum([
  "read",
  "upload",
  "download",
  "delete",
  "write",
  "full",
  "admin",
  "admin:users",
  "admin:settings",
  "admin:stats",
  "admin:monitoring",
  "admin:shares",
  "admin:email",
  "supreme",
]);

const createSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    scopes: z.array(masterScopeEnum).min(1).optional(),
    preset: z
      .enum(["supreme_command", "platform_ai", "ops_center", "user_governor", "automation_god"])
      .optional(),
    expiresInDays: z.number().int().positive().max(3650).nullable().optional(),
  })
  .refine((body) => body.preset || (body.name && body.scopes?.length), {
    message: "Provide a preset or both name and scopes",
  });

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const master = await requireMaster();
    const body = createSchema.parse(await request.json());
    const ip = getClientIp(request);

    let name: string;
    let scopes: MasterApiKeyScope[];
    let expiresAt: Date | null = null;

    if (body.preset) {
      const preset = MASTER_API_KEY_PRESETS[body.preset as MasterApiKeyPreset];
      name = body.name?.trim() || preset.name;
      scopes = [...preset.scopes];
      const days = body.expiresInDays ?? preset.expiresInDays;
      expiresAt = days ? new Date(Date.now() + days * 86400000) : null;
    } else {
      name = body.name!.trim();
      scopes = normalizeMasterApiKeyScopes(body.scopes ?? []);
      if (scopes.length === 0) return apiError("At least one valid scope required", 400);
      expiresAt = body.expiresInDays
        ? new Date(Date.now() + body.expiresInDays * 86400000)
        : null;
    }

    const key = await createMasterApiKey(master.id, name, scopes, expiresAt);

    await logActivity(master, "edit", {
      resourceType: "master_api_key",
      resourceId: key.id,
      metadata: { action: "create", name: key.name, scopes: key.scopes },
      ip,
    });

    return apiSuccess({ key });
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

    const master = await requireMaster();
    const { id } = deleteSchema.parse(await request.json());
    const ip = getClientIp(request);

    const ok = await deleteMasterApiKey(master.id, id);
    if (!ok) return apiError("Master API key not found", 404);

    await logActivity(master, "edit", {
      resourceType: "master_api_key",
      resourceId: id,
      metadata: { action: "revoke" },
      ip,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}

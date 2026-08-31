import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/shared/infrastructure/db";
import { users } from "@/shared/infrastructure/db/schema";
import { requireAuth, getClientIp } from "@/shared/lib/auth/session";
import { logActivity } from "@/shared/lib/auth/audit";
import { validateCsrf } from "@/shared/lib/security";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import {
  generateTotpSecret,
  verifyTotpCode,
  generateRecoveryCodes,
} from "@/shared/lib/security/totp";
import { verifyPassword } from "@/shared/lib/auth/password";

/** Start 2FA setup — returns secret + otpauth URI (not enabled until confirm). */
export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();

    if (user.totpEnabled) {
      return apiError("2FA is already enabled", 400);
    }

    const { secret, uri } = generateTotpSecret();
    await db
      .update(users)
      .set({ totpSecret: secret, updatedAt: new Date() })
      .where(eq(users.id, user.id));

    return apiSuccess({
      secret,
      otpauthUrl: uri(user.username),
    });
  } catch (error) {
    return handleApiError(error);
  }
}

const confirmSchema = z.object({
  code: z.string().min(6).max(8),
});

/** Confirm setup with a valid TOTP code — enables 2FA + returns recovery codes once. */
export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const ip = getClientIp(request);
    const body = confirmSchema.parse(await request.json());

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row?.totpSecret) return apiError("Start 2FA setup first", 400);
    if (!verifyTotpCode(row.totpSecret, body.code)) {
      return apiError("Invalid authenticator code", 400);
    }

    const { plain, hashed } = await generateRecoveryCodes(8);
    await db
      .update(users)
      .set({
        totpEnabled: true,
        totpRecoveryCodes: hashed,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await logActivity(user, "password_change", {
      ip,
      metadata: { action: "2fa_enabled" },
    });

    return apiSuccess({ enabled: true, recoveryCodes: plain });
  } catch (error) {
    return handleApiError(error);
  }
}

const disableSchema = z.object({
  password: z.string().min(1),
  code: z.string().optional(),
});

/** Disable 2FA — requires password (+ TOTP if still enabled). */
export async function DELETE(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);
    const user = await requireAuth();
    const ip = getClientIp(request);
    const body = disableSchema.parse(await request.json());

    const [row] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    if (!row) return apiError("User not found", 404);

    const valid = await verifyPassword(body.password, row.passwordHash);
    if (!valid) return apiError("Invalid password", 401);

    if (row.totpEnabled && row.totpSecret) {
      if (!body.code || !verifyTotpCode(row.totpSecret, body.code)) {
        return apiError("Invalid authenticator code", 400);
      }
    }

    await db
      .update(users)
      .set({
        totpEnabled: false,
        totpSecret: null,
        totpRecoveryCodes: [],
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));

    await logActivity(user, "password_change", {
      ip,
      metadata: { action: "2fa_disabled" },
    });

    return apiSuccess({ enabled: false });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function GET() {
  try {
    const user = await requireAuth();
    return apiSuccess({
      totpEnabled: user.totpEnabled,
      recoveryCodesRemaining: Array.isArray(user.totpRecoveryCodes)
        ? user.totpRecoveryCodes.length
        : 0,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

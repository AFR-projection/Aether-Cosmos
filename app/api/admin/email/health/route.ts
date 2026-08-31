import { NextRequest } from "next/server";
import { requireMasterOrApiKey } from "@/shared/lib/auth/api-key";
import { apiSuccess, handleApiError } from "@/shared/api/response";
import { db } from "@/shared/infrastructure/db";
import { mailSenders } from "@/shared/infrastructure/db/schema";
import { getRouterConfig, checkEligibility } from "@/shared/infrastructure/email/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Email gateway diagnostics for admins — surfaces at a glance whether OTP /
 * notifications can actually be delivered: how many senders exist, how many are
 * active/verified, and — via the smart router — how many are eligible to send
 * RIGHT NOW (not on cooldown, not at their daily cap).
 */
export async function GET(request: NextRequest) {
  try {
    await requireMasterOrApiKey(request, "email");

    const now = Date.now();
    const cfg = await getRouterConfig();
    const senders = await db.select().from(mailSenders);
    const active = senders.filter((s) => s.isActive);
    const ready = active.filter((s) => s.status === "ok");
    const eligible = senders.filter((s) => checkEligibility(s, cfg, now).eligible);
    const cooling = active.filter((s) => s.cooldownUntil && s.cooldownUntil.getTime() > now);

    const problems: string[] = [];
    const problemCodes: Array<"none" | "unverified" | "unavailable"> = [];
    if (senders.length === 0) {
      problemCodes.push("none");
      problems.push("No Gmail sender configured yet. Add one to start sending OTP and notifications.");
    } else if (ready.length === 0) {
      problemCodes.push("unverified");
      problems.push(
        "No sender is verified. Check each sender's App Password (16 chars, 2-Step Verification enabled) and re-run Test."
      );
    } else if (eligible.length === 0) {
      problemCodes.push("unavailable");
      problems.push(
        "Every verified sender is on cooldown or at its daily limit right now. Add another sender or raise the daily limit."
      );
    }

    return apiSuccess({
      healthy: eligible.length > 0,
      totalSenders: senders.length,
      activeSenders: active.length,
      readySenders: ready.length,
      eligibleSenders: eligible.length,
      coolingSenders: cooling.length,
      defaultDailyLimit: cfg.defaultDailyLimit,
      problems,
      problemCodes,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

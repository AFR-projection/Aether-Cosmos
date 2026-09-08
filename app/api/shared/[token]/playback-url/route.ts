import { NextRequest } from "next/server";
import { performance } from "node:perf_hooks";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { shares, files } from "@/shared/infrastructure/db/schema";
import { getPresignedPlaybackUrl } from "@files/infrastructure/storage/r2";
import { BandwidthQuotaError } from "@/shared/lib/billing/bandwidth";
import {
  apiError,
  apiRateLimited,
  apiSuccess,
  handleApiError,
} from "@/shared/api/response";
import { getSafeMimeType } from "@/shared/lib/security/mime";
import {
  getAdminSettings,
  playbackProxyForced,
} from "@/shared/lib/settings/admin-settings";
import {
  reserveSharePlaybackAccess,
  shareExpired,
} from "@shares/application/access";
import { isPossibleShareToken } from "@shares/domain/token";
import {
  playbackEligibility,
  PLAYBACK_REFUSAL_STATUS,
  type PlaybackRefusalReason,
} from "@files/domain/services/playback";
import { checkRateLimit } from "@/shared/lib/security";
import { getClientIpFromRequest } from "@/shared/lib/access-tracking";
import { recordPlaybackIssue } from "@/shared/lib/monitoring/playback-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Control plane for playback from a public share link.
 *
 * The rate limit moved with the work. `/api/shared/[token]/preview` allows 60 requests per
 * minute per IP, which is right for a route that serves bytes — except a video issues one range
 * request per buffer segment and per seek, so a viewer who scrubs around could trip it and see
 * a 429 as a stall. Issuance is once per viewing, so the ceiling here is much lower AND much
 * harder to hit legitimately: 12 per minute is a person opening links, not a script harvesting
 * them.
 *
 * The access budget (`maxAccessCount`) is claimed here, once, in the same single statement the
 * byte route used. What "one access" buys does change slightly: it used to mean one delivery
 * plus free continuations inside a 5-minute window, and now it means one presigned URL valid
 * for its lifetime. Both amount to "one viewer can read the whole object once", which is what
 * the setting was always understood to mean.
 */
const PLAYBACK_URL_MAX_PER_MINUTE = 12;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const startedAt = performance.now();
  let permissionMs = 0;
  let presignMs = 0;

  const note = (
    outcome: "issued" | "refused" | "error",
    reason: string | null,
    status: number,
    file?: { sizeBytes: number; mimeType: string },
  ) => {
    recordPlaybackIssue({
      surface: "share",
      outcome,
      reason,
      status,
      // Anonymous: there is no session to look up, so the auth stage genuinely costs nothing.
      authMs: 0,
      permissionMs,
      presignMs,
      totalMs: performance.now() - startedAt,
      sizeBytes: file?.sizeBytes ?? null,
      mimeType: file?.mimeType ?? null,
    });
  };

  const refuse = (reason: PlaybackRefusalReason, message: string) => {
    const status = PLAYBACK_REFUSAL_STATUS[reason];
    note("refused", reason, status);
    return apiError(message, status, {
      code: `PLAYBACK_${reason.toUpperCase().replace(/-/g, "_")}`,
    });
  };

  try {
    const { token } = await params;
    // Same non-oracle as the byte route: a token that cannot exist gets the answer of one that
    // does not, and the unbounded path segment never reaches a query or a rate-limit key.
    if (!isPossibleShareToken(token)) {
      note("refused", "bad-token", 404);
      return apiError("Share not found", 404, { code: "PLAYBACK_NOT_FOUND" });
    }

    const ip = getClientIpFromRequest(request);
    const limit = await checkRateLimit(
      `share_playback_url:${ip}`,
      PLAYBACK_URL_MAX_PER_MINUTE,
      60_000,
    );
    if (!limit.allowed) {
      note("refused", "rate-limited", 429);
      return apiRateLimited("Too many requests. Slow down.", 60, {
        code: "RATE_LIMITED",
      });
    }

    /**
     * The same rollback switch the authenticated route honours, and the player reads the refusal
     * the same way: fall back to `/api/shared/[token]/preview`.
     *
     * `await` rather than the sync snapshot, because nothing has warmed it on this path — there
     * is no session to look up. It is cached for 30 s and read once per issuance, and it sits
     * behind the rate limit so an anonymous flood cannot turn it into a query per request.
     */
    if (playbackProxyForced(await getAdminSettings())) {
      note("refused", "proxy-forced", 409);
      return apiError("Direct playback is disabled on this server.", 409, {
        code: "PLAYBACK_PROXY_FORCED",
      });
    }

    const permissionStart = performance.now();
    const [share] = await db
      .select()
      .from(shares)
      .where(eq(shares.token, token))
      .limit(1);
    if (!share) {
      permissionMs = performance.now() - permissionStart;
      note("refused", "no-share", 404);
      return apiError("Share not found", 404, { code: "PLAYBACK_NOT_FOUND" });
    }

    const [file] = await db
      .select()
      .from(files)
      .where(
        and(
          eq(files.id, share.fileId),
          isNull(files.deletedAt),
          eq(files.status, "ready"),
        ),
      )
      .limit(1);
    permissionMs = performance.now() - permissionStart;

    if (!file) {
      note("refused", "no-file", 404);
      return apiError("File not found", 404, { code: "PLAYBACK_NOT_FOUND" });
    }

    if (shareExpired(share)) {
      note("refused", "share-expired", 410);
      return apiError("Share link expired", 410, { code: "SHARE_EXPIRED" });
    }

    const eligibility = playbackEligibility(file);
    if (!eligibility.ok) {
      switch (eligibility.reason) {
        case "encrypted":
          return refuse(
            "encrypted",
            "This file is end-to-end encrypted; it plays through the browser after you unlock it.",
          );
        case "not-ready":
          return refuse(
            "not-ready",
            "This file hasn't finished uploading yet.",
          );
        case "no-object":
          return refuse("no-object", "This file isn't in storage.");
        case "note":
          return refuse("note", "Notes have no media to play.");
        case "unsupported":
          return refuse("unsupported", "This file isn't a video.");
      }
    }

    const contentType = getSafeMimeType(
      file.mimeType || "video/mp4",
      file.name,
    );

    // Create the private capability first, but do not return or log it until both
    // counters commit. Signing failure therefore changes no accounting state.
    const presignStart = performance.now();
    const signed = await getPresignedPlaybackUrl(file.r2Key, { contentType });
    presignMs = performance.now() - presignStart;

    // One transaction reserves the link's unit and the owner's egress. Neither
    // counter can move alone when quota, exhaustion, or a database failure refuses
    // issuance.
    let reservation;
    try {
      reservation = await reserveSharePlaybackAccess(
        share.id,
        file.userId,
        file.sizeBytes,
      );
    } catch (error) {
      if (error instanceof BandwidthQuotaError) {
        note("refused", "bandwidth-quota", 429);
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429, {
          code: "BANDWIDTH_QUOTA_EXCEEDED",
        });
      }
      throw error;
    }

    if (reservation !== "reserved") {
      note(
        "refused",
        reservation === "share-exhausted"
          ? "budget-exhausted"
          : "share-unavailable",
        reservation === "share-exhausted" ? 403 : 404,
      );
      return reservation === "share-exhausted"
        ? apiError("Share link has reached maximum access limit", 403, {
            code: "SHARE_EXHAUSTED",
          })
        : apiError("Share not found", 404, { code: "PLAYBACK_NOT_FOUND" });
    }

    note("issued", null, 200, {
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
    });

    return apiSuccess({
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      expiresInSeconds: signed.expiresInSeconds,
      mimeType: contentType,
      sizeBytes: file.sizeBytes,
      version: file.version,
    });
  } catch (error) {
    note("error", error instanceof Error ? error.name : "unknown", 500);
    return handleApiError(error);
  }
}

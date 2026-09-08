import { performance } from "node:perf_hooks";
import { requireAuth } from "@/shared/lib/auth/session";
import { getAccessibleFile } from "@/shared/lib/auth/permissions";
import { getPresignedPlaybackUrl } from "@files/infrastructure/storage/r2";
import {
  recordBandwidth,
  BandwidthQuotaError,
} from "@/shared/lib/billing/bandwidth";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import { getSafeMimeType } from "@/shared/lib/security/mime";
import { playbackProxyForced } from "@/shared/lib/settings/admin-settings";
import {
  playbackEligibility,
  PLAYBACK_REFUSAL_STATUS,
  type PlaybackRefusalReason,
} from "@files/domain/services/playback";
import { recordPlaybackIssue } from "@/shared/lib/monitoring/playback-telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The control plane for private video playback.
 *
 * This endpoint is the whole authorization story for one viewing: it checks the session, checks
 * the permission, meters the egress, and hands back a presigned R2 URL. After that the browser
 * talks to R2 directly and neither Next.js nor Aiven sees another byte — no session lookup per
 * buffer segment, no permission query per seek, no row lock per chunk.
 *
 * Why that is the fix rather than an optimisation: `/api/files/[id]/preview` pays ~520 ms of
 * serial Aiven round trips (measured, `docs/playback-measurement-before.md`) BEFORE it asks R2
 * for anything, and a player issues one range request per buffer segment and one per seek. The
 * cost was never in any single request; it was in paying authorization hundreds of times for an
 * answer that cannot change mid-film.
 *
 * Egress is billed once, here, for the whole object — exactly what the proxy route already did
 * on its first (non-continuation) request. Same accounting, and the meter is now nowhere near
 * the bytes. See PHASE 9 in docs/playback-architecture.md for why per-byte billing was not
 * rebuilt on top of client telemetry.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const startedAt = performance.now();
  let authMs = 0;
  let permissionMs = 0;
  let presignMs = 0;

  const refuse = (
    reason: PlaybackRefusalReason,
    message: string,
    extra?: Record<string, unknown>,
  ) => {
    const status = PLAYBACK_REFUSAL_STATUS[reason];
    recordPlaybackIssue({
      surface: "file",
      outcome: "refused",
      reason,
      status,
      authMs,
      permissionMs,
      presignMs,
      totalMs: performance.now() - startedAt,
      sizeBytes: null,
      mimeType: null,
    });
    return apiError(message, status, {
      code: `PLAYBACK_${reason.toUpperCase().replace(/-/g, "_")}`,
      ...extra,
    });
  };

  try {
    const authStart = performance.now();
    const sessionUser = await requireAuth();
    authMs = performance.now() - authStart;

    /**
     * The rollback switch, enforced here rather than in the browser.
     *
     * `playbackMode: "legacy_proxy"` has to take effect the moment an operator flips it, on
     * clients that are already loaded — so the server refuses to issue and the player falls back
     * to `/api/files/[id]/preview` on its own. One cheap request per video in the rolled-back
     * state buys a switch that needs no deploy. Checked before the file lookup because the
     * answer is the same for every id, and before `recordBandwidth` so the proxy keeps doing
     * the metering exactly as it always did.
     *
     * `requireAuth` has already warmed the settings snapshot, so this reads no database.
     */
    if (playbackProxyForced()) {
      recordPlaybackIssue({
        surface: "file",
        outcome: "refused",
        reason: "proxy-forced",
        status: 409,
        authMs,
        permissionMs,
        presignMs,
        totalMs: performance.now() - startedAt,
        sizeBytes: null,
        mimeType: null,
      });
      return apiError("Direct playback is disabled on this server.", 409, {
        code: "PLAYBACK_PROXY_FORCED",
      });
    }

    const { id } = await params;

    const permissionStart = performance.now();
    const accessible = await getAccessibleFile(sessionUser, id);
    permissionMs = performance.now() - permissionStart;

    if (!accessible?.canView) {
      recordPlaybackIssue({
        surface: "file",
        outcome: "refused",
        reason: "not-found",
        status: 404,
        authMs,
        permissionMs,
        presignMs,
        totalMs: performance.now() - startedAt,
        sizeBytes: null,
        mimeType: null,
      });
      return apiError("File not found", 404, { code: "PLAYBACK_NOT_FOUND" });
    }

    const file = accessible.file;
    const eligibility = playbackEligibility(file);
    if (!eligibility.ok) {
      // Each of these is a different instruction to the caller, which is why they are not one
      // "couldn't play this" message: `encrypted` means "use the decryption path", `not-ready`
      // means "come back in a moment", `unsupported` means "this endpoint is for video".
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
          return refuse(
            "no-object",
            "This file isn't in storage yet. Try uploading it again.",
          );
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

    // Create the bearer capability before any irreversible accounting, but keep it
    // server-side until the reservation commits. A signing outage must not charge a
    // viewer for a URL they never receive.
    const presignStart = performance.now();
    const signed = await getPresignedPlaybackUrl(file.r2Key, { contentType });
    presignMs = performance.now() - presignStart;

    // Metered once per issuance, for the whole object. Over-bills somebody who watches ten
    // seconds — bounded and predictable — and in exchange the meter is not in the byte path
    // at all, which is where it used to serialise concurrent chunks on one `users` row.
    try {
      await recordBandwidth(file.userId, file.sizeBytes);
    } catch (error) {
      if (error instanceof BandwidthQuotaError) {
        recordPlaybackIssue({
          surface: "file",
          outcome: "refused",
          reason: "bandwidth-quota",
          status: 429,
          authMs,
          permissionMs,
          presignMs,
          totalMs: performance.now() - startedAt,
          sizeBytes: file.sizeBytes,
          mimeType: file.mimeType,
        });
        return apiError("BANDWIDTH_QUOTA_EXCEEDED", 429, {
          code: "BANDWIDTH_QUOTA_EXCEEDED",
        });
      }
      throw error;
    }

    recordPlaybackIssue({
      surface: "file",
      outcome: "issued",
      reason: null,
      status: 200,
      authMs,
      permissionMs,
      presignMs,
      totalMs: performance.now() - startedAt,
      sizeBytes: file.sizeBytes,
      mimeType: file.mimeType,
    });

    return apiSuccess({
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      expiresInSeconds: signed.expiresInSeconds,
      mimeType: contentType,
      sizeBytes: file.sizeBytes,
      // The player keys its element on this, so a trimmed or re-encoded file reloads instead
      // of continuing to play bytes that are no longer there.
      version: file.version,
    });
  } catch (error) {
    recordPlaybackIssue({
      surface: "file",
      outcome: "error",
      reason: error instanceof Error ? error.name : "unknown",
      status: 500,
      authMs,
      permissionMs,
      presignMs,
      totalMs: performance.now() - startedAt,
      sizeBytes: null,
      mimeType: null,
    });
    return handleApiError(error);
  }
}

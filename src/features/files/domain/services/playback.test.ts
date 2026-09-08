import { describe, it, expect } from "vitest";
import {
  PLAYBACK_REFUSAL_STATUS,
  isPlayableVideoMime,
  playbackEligibility,
  type PlaybackCandidate,
  type PlaybackRefusalReason,
} from "@files/domain/services/playback";

/**
 * The gate in front of a presigned R2 URL.
 *
 * A presigned URL is a bearer capability: anyone holding it reads the object until it expires,
 * with no session and no further check. So this function is not a convenience — it is the last
 * place that can decide an object should never be handed out directly, and the ORDER of its
 * checks is part of the answer. `encrypted` before the MIME test, for instance, is what makes an
 * encrypted video get a routing answer ("use the decryption path") instead of a format
 * complaint about ciphertext that still declares itself `video/mp4`.
 *
 * Both playback routes call this and nothing else before signing.
 */

function candidate(
  overrides: Partial<PlaybackCandidate> = {},
): PlaybackCandidate {
  return {
    mimeType: "video/mp4",
    sizeBytes: 734_003_200,
    r2Key: "users/u1/films/heat.mp4",
    status: "ready",
    isNote: false,
    encrypted: false,
    ...overrides,
  };
}

describe("isPlayableVideoMime", () => {
  it("accepts what a browser actually sends back for a video", () => {
    expect(isPlayableVideoMime("video/mp4")).toBe(true);
    expect(isPlayableVideoMime("video/webm")).toBe(true);
    expect(isPlayableVideoMime("video/quicktime")).toBe(true);
  });

  it("ignores parameters and case, because stored MIME types have both", () => {
    // Uploads carry whatever the client declared. A codecs parameter or a shouting extension
    // must not be the reason a film refuses to play.
    expect(
      isPlayableVideoMime('video/mp4; codecs="avc1.640029, mp4a.40.2"'),
    ).toBe(true);
    expect(isPlayableVideoMime("VIDEO/MP4")).toBe(true);
    expect(isPlayableVideoMime("  video/mp4  ")).toBe(true);
  });

  it("rejects everything else, including near misses", () => {
    expect(isPlayableVideoMime("audio/mp4")).toBe(false);
    expect(isPlayableVideoMime("application/mp4")).toBe(false);
    expect(isPlayableVideoMime("application/octet-stream")).toBe(false);
    expect(isPlayableVideoMime("")).toBe(false);
    // Not "starts with video/" by accident: the type, not the subtype.
    expect(isPlayableVideoMime("application/x-video/mp4")).toBe(false);
  });
});

describe("playbackEligibility", () => {
  it("allows a ready video that has an object", () => {
    expect(playbackEligibility(candidate())).toEqual({ ok: true });
  });

  it("allows a legacy file whose object was never re-verified", () => {
    // These play today through the proxy. Refusing them here would be a regression dressed up
    // as caution.
    expect(
      playbackEligibility(candidate({ status: "legacy_unverified" })),
    ).toEqual({ ok: true });
  });

  it("refuses a note, by flag or by key", () => {
    // A note has no R2 object at all; the key check catches rows whose flag was never set.
    expect(playbackEligibility(candidate({ isNote: true }))).toEqual({
      ok: false,
      reason: "note",
    });
    expect(
      playbackEligibility(candidate({ r2Key: "notes/u1/thoughts.json" })),
    ).toEqual({
      ok: false,
      reason: "note",
    });
  });

  it("refuses anything still uploading, quarantined or deleted", () => {
    for (const status of [
      "uploading",
      "pending",
      "processing",
      "infected",
      "deleted",
      "",
    ]) {
      expect(playbackEligibility(candidate({ status }))).toEqual({
        ok: false,
        reason: "not-ready",
      });
    }
  });

  it("refuses a row with no object behind it", () => {
    // Signing these produces a URL that returns 404 from R2 — a black rectangle with no
    // explanation, which is the failure mode this whole change exists to remove.
    expect(playbackEligibility(candidate({ r2Key: "" }))).toEqual({
      ok: false,
      reason: "no-object",
    });
    expect(playbackEligibility(candidate({ r2Key: "pending" }))).toEqual({
      ok: false,
      reason: "no-object",
    });
    expect(playbackEligibility(candidate({ sizeBytes: 0 }))).toEqual({
      ok: false,
      reason: "no-object",
    });
    expect(playbackEligibility(candidate({ sizeBytes: -1 }))).toEqual({
      ok: false,
      reason: "no-object",
    });
  });

  it("refuses an encrypted video as encrypted, not as a broken video", () => {
    expect(playbackEligibility(candidate({ encrypted: true }))).toEqual({
      ok: false,
      reason: "encrypted",
    });
  });

  it("refuses a non-video that someone asked to play", () => {
    expect(
      playbackEligibility(candidate({ mimeType: "application/pdf" })),
    ).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(playbackEligibility(candidate({ mimeType: "audio/mpeg" }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  describe("precedence", () => {
    /**
     * Each of these rows is broken in two ways at once, and only one answer is useful to the
     * client. The order is: note → status → object → encrypted → format.
     */
    it("prefers note over every other complaint", () => {
      expect(
        playbackEligibility(
          candidate({
            isNote: true,
            status: "uploading",
            r2Key: "",
            mimeType: "text/plain",
          }),
        ),
      ).toEqual({ ok: false, reason: "note" });
    });

    it("prefers not-ready over a missing object", () => {
      // A file mid-upload has no key yet. Saying "no object" would suggest it never will.
      expect(
        playbackEligibility(
          candidate({ status: "uploading", r2Key: "pending" }),
        ),
      ).toEqual({
        ok: false,
        reason: "not-ready",
      });
    });

    it("prefers a missing object over the encryption routing hint", () => {
      // Sending the browser down the decryption path for bytes that do not exist would waste a
      // passphrase prompt on a file it cannot fetch.
      expect(
        playbackEligibility(candidate({ r2Key: "pending", encrypted: true })),
      ).toEqual({
        ok: false,
        reason: "no-object",
      });
    });

    it("prefers encrypted over unsupported", () => {
      // An encrypted upload's stored MIME may be the generic stream type. The client still needs
      // to be told to decrypt, not that the format is wrong.
      expect(
        playbackEligibility(
          candidate({ encrypted: true, mimeType: "application/octet-stream" }),
        ),
      ).toEqual({ ok: false, reason: "encrypted" });
    });
  });
});

describe("PLAYBACK_REFUSAL_STATUS", () => {
  it("has a status for every reason the gate can return", () => {
    // A missing entry would be `undefined` in a `new Response(null, { status })` call, which
    // throws at runtime inside a route that is otherwise working.
    const reasons: PlaybackRefusalReason[] = [
      "not-ready",
      "no-object",
      "note",
      "encrypted",
      "unsupported",
    ];
    for (const reason of reasons) {
      expect(typeof PLAYBACK_REFUSAL_STATUS[reason]).toBe("number");
    }
    expect(Object.keys(PLAYBACK_REFUSAL_STATUS).sort()).toEqual(
      [...reasons].sort(),
    );
  });

  it("never answers a refusal with a success or a server error", () => {
    // The client's `classify` treats 5xx as "the server is broken, fall back to the proxy". A
    // refusal that arrived as 500 would silently route every unplayable file through the VPS.
    for (const status of Object.values(PLAYBACK_REFUSAL_STATUS)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
  });

  it("keeps encrypted and not-ready retryable and the rest final", () => {
    expect(PLAYBACK_REFUSAL_STATUS.encrypted).toBe(409);
    expect(PLAYBACK_REFUSAL_STATUS["not-ready"]).toBe(409);
    expect(PLAYBACK_REFUSAL_STATUS["no-object"]).toBe(404);
    expect(PLAYBACK_REFUSAL_STATUS.note).toBe(400);
    expect(PLAYBACK_REFUSAL_STATUS.unsupported).toBe(415);
  });
});

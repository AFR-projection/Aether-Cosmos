/**
 * How the player survives a dead capability.
 *
 * The control plane can refuse for reasons the viewer must NOT paper over with the legacy
 * proxy (a quota or an expired share is a settled answer, not a broken pipe), and a dead
 * media element can fail for reasons a fresh URL will or will not fix. Those decisions are
 * made here, as pure functions, so the hook and the viewer stay responsible for state and
 * timing only. The numbers match the server contract pinned in
 * `tests/playback-capability-routes.test.ts` and the expiry policy in
 * `src/shared/lib/media/playback-policy.ts`.
 */

export type PlaybackErrorCode =
  | "unauthorized"
  | "not-found"
  | "not-ready"
  | "unsupported"
  | "quota"
  | "rate-limited"
  | "share-expired"
  | "share-exhausted"
  | "server"
  | "network";

/**
 * Turn a capability refusal into the cause the viewer should act on. The named refusal
 * codes win over the status: the server may answer a quota with 402 or a 5xx on an older
 * deployment, and the code is the contract. A `0` status means the request never
 * completed — no response to read, which is a network break, not a server refusal.
 */
export function classifyRefusal(
  status: number,
  code: string | undefined,
): PlaybackErrorCode {
  if (status === 0) return "network";
  switch (code) {
    case "PLAYBACK_NOT_FOUND":
      return "not-found";
    case "PLAYBACK_NOT_READY":
    case "PLAYBACK_NO_OBJECT":
      return "not-ready";
    case "PLAYBACK_UNSUPPORTED":
    case "PLAYBACK_NOTE":
      return "unsupported";
    case "BANDWIDTH_QUOTA_EXCEEDED":
      return "quota";
    case "RATE_LIMITED":
      return "rate-limited";
    case "SHARE_EXPIRED":
      return "share-expired";
    case "SHARE_EXHAUSTED":
      return "share-exhausted";
    default:
      break;
  }
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not-found";
  return "server";
}

/**
 * Only a broken path goes to the legacy proxy. A settled refusal — quota, expired share,
 * missing file — must stay a refusal: the proxy would re-run the same authorization and
 * accounting and get the same answer, while quietly burning the fallback.
 */
export function isFallbackWorthy(errorCode: PlaybackErrorCode): boolean {
  return errorCode === "server" || errorCode === "network";
}

/**
 * How many failed re-issues are tolerated while the current URL still works, before the
 * player gives up and falls back. The first issuance is never retried this way — a failed
 * start has no working URL to hold.
 */
export const REFRESH_MAX_ATTEMPTS = 5;

export type IssuanceFailureAction = "proxy" | "retry" | "fallback" | "error";

export interface IssuanceFailureInput {
  /** The refusal code from the server, if it answered at all. */
  refusalCode: string | null;
  /** True when a working URL already plays and only the refresh failed. */
  isRefresh: boolean;
  /** Failed refreshes including this one. */
  attempts: number;
  errorCode: PlaybackErrorCode;
  hasFallbackUrl: boolean;
}

/**
 * What the player does when an issuance (or re-issuance) fails.
 *
 * - `proxy`: the operator forced the legacy path — no error, no timer, no retries.
 * - `retry`: a refresh failed but the budget lasts; keep the current URL, try again later.
 * - `fallback`: the path is broken (or the refresh budget is spent) — move to the proxy
 *   without announcing an error the viewer can already see.
 * - `error`: nothing left to try, or the answer is settled — say what actually happened.
 */
export function issuanceFailureAction(input: IssuanceFailureInput): IssuanceFailureAction {
  if (input.refusalCode === "PLAYBACK_PROXY_FORCED" && input.hasFallbackUrl) {
    return "proxy";
  }
  if (input.isRefresh && input.attempts < REFRESH_MAX_ATTEMPTS) {
    return "retry";
  }
  if (input.hasFallbackUrl && isFallbackWorthy(input.errorCode)) {
    return "fallback";
  }
  return "error";
}

/**
 * How many times one `<video>` element will re-issue a capability after a media error,
 * before it declares the failure. A truncated object breaks again on a fresh URL, so the
 * budget is small; a successful `playing` event resets it.
 */
export const MEDIA_RECOVERY_LIMIT = 2;

export type MediaErrorOutcome = "ignore" | "recover" | "decode" | "network" | "unsupported";

export interface MediaErrorInput {
  /** MEDIA_ERR_ABORTED: our own URL replacement is what aborted the load. */
  aborted: boolean;
  /** MEDIA_ERR_DECODE: the bytes themselves are unplayable. */
  decode: boolean;
  /** MEDIA_ERR_NETWORK, or a code-0 load that found nothing. */
  network: boolean;
  /** The player is on the direct-R2 path, so a fresh capability can be issued. */
  reissuable: boolean;
  /** Media-error recoveries already used for this element since it last played. */
  recoveryAttempts: number;
  recoveryLimit: number;
}

/**
 * What the viewer does when the media element reports an error.
 *
 * A fresh URL delivers the same bytes, so only a network-shaped failure on the direct path
 * is worth re-issuing — and only while the budget lasts. Decode failures are reported as
 * what they are; the proxy cannot re-issue at all and says the honest thing.
 */
export function mediaErrorOutcome(input: MediaErrorInput): MediaErrorOutcome {
  if (input.aborted) return "ignore";
  if (input.reissuable && !input.decode && input.recoveryAttempts < input.recoveryLimit) {
    return "recover";
  }
  if (input.decode) return "decode";
  if (input.network) return "network";
  return "unsupported";
}

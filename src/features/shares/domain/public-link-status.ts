export interface PublicLinkStatusInput {
  expiresAt: string | null;
  accessCount: number;
  maxAccessCount: number | null;
}

export type PublicLinkStatus = "expired" | "limit-reached" | "active";

export function derivePublicLinkStatus(
  share: PublicLinkStatusInput,
  now: Date = new Date()
): PublicLinkStatus {
  if (share.expiresAt && new Date(share.expiresAt).getTime() <= now.getTime()) {
    return "expired";
  }
  if (
    share.maxAccessCount !== null &&
    share.accessCount >= share.maxAccessCount
  ) {
    return "limit-reached";
  }
  return "active";
}

export function isPublicLinkActive(
  share: PublicLinkStatusInput,
  now: Date = new Date()
): boolean {
  return derivePublicLinkStatus(share, now) === "active";
}

import type { EncryptionMetaV1 } from "@/shared/lib/crypto/client-encryption";
import { getMimeCategory } from "@/shared/lib/utils";

export type SharedPlaybackTarget = { kind: "share"; token: string };

export type SharedPlaybackFile = {
  isNote?: boolean;
  mimeType: string;
  encrypted?: boolean;
  encryptionMeta?: unknown;
};

export function sharedPlaybackTarget(
  file: SharedPlaybackFile | null,
  token: string,
): SharedPlaybackTarget | null {
  if (
    !file ||
    file.isNote ||
    file.encrypted ||
    getMimeCategory(file.mimeType) !== "video"
  ) {
    return null;
  }

  return { kind: "share", token };
}

export function sharedEncryptionMeta(
  file: SharedPlaybackFile,
): EncryptionMetaV1 | null {
  const meta = file.encryptionMeta;
  if (!file.encrypted || !meta || typeof meta !== "object") return null;

  const candidate = meta as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.salt !== "string" ||
    candidate.salt.length === 0 ||
    typeof candidate.iv !== "string" ||
    candidate.iv.length === 0
  ) {
    return null;
  }

  return candidate as EncryptionMetaV1;
}

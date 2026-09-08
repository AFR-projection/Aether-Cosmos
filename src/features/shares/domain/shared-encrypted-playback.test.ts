import { describe, expect, it } from "vitest";
import {
  sharedEncryptionMeta,
  sharedPlaybackTarget,
} from "./shared-encrypted-playback";

const TOKEN = "x".repeat(32);

function video(over: Record<string, unknown> = {}) {
  return { mimeType: "video/mp4", isNote: false, ...over };
}

describe("shared video delivery", () => {
  it("issues a direct target only for plaintext video", () => {
    expect(sharedPlaybackTarget(video(), TOKEN)).toEqual({
      kind: "share",
      token: TOKEN,
    });
  });

  it("keeps encrypted video off the direct capability path", () => {
    expect(sharedPlaybackTarget(video({ encrypted: true }), TOKEN)).toBeNull();
  });

  it("accepts only complete encryption metadata for browser decryption", () => {
    const valid = { version: 1, salt: "salt", iv: "iv" };
    expect(
      sharedEncryptionMeta(video({ encrypted: true, encryptionMeta: valid })),
    ).toEqual(valid);
    expect(
      sharedEncryptionMeta(
        video({
          encrypted: true,
          encryptionMeta: { version: 1, salt: "salt" },
        }),
      ),
    ).toBeNull();
  });
});

import { describe, it, expect, beforeEach } from "vitest";

import {
  getPendingEncryptedDownload,
  setPendingEncryptedDownload,
  clearPendingEncryptedDownload,
  subscribePendingEncryptedDownload,
  type PendingEncryptedDownload,
} from "@files/application/commands/encrypted-download-store";

const sample: PendingEncryptedDownload = {
  fileId: "file-1",
  fileName: "secret.png",
  mimeType: "image/png",
  meta: { salt: "c2FsdA==", iv: "aXY=", version: 1 },
};

beforeEach(() => {
  clearPendingEncryptedDownload();
});

describe("encrypted-download-store", () => {
  it("starts empty", () => {
    expect(getPendingEncryptedDownload()).toBeNull();
  });

  it("stores and clears a pending download", () => {
    setPendingEncryptedDownload(sample);
    expect(getPendingEncryptedDownload()).toEqual(sample);
    clearPendingEncryptedDownload();
    expect(getPendingEncryptedDownload()).toBeNull();
  });

  it("notifies subscribers on set and clear", () => {
    let ticks = 0;
    const unsub = subscribePendingEncryptedDownload(() => {
      ticks++;
    });
    setPendingEncryptedDownload(sample);
    clearPendingEncryptedDownload();
    unsub();
    // one for set, one for clear
    expect(ticks).toBe(2);
  });

  it("does not notify when clearing an already-empty store", () => {
    let ticks = 0;
    const unsub = subscribePendingEncryptedDownload(() => {
      ticks++;
    });
    clearPendingEncryptedDownload();
    unsub();
    expect(ticks).toBe(0);
  });

  it("stops notifying after unsubscribe", () => {
    let ticks = 0;
    const unsub = subscribePendingEncryptedDownload(() => {
      ticks++;
    });
    unsub();
    setPendingEncryptedDownload(sample);
    expect(ticks).toBe(0);
  });
});

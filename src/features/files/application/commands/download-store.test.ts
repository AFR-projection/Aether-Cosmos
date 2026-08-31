import { describe, it, expect, beforeEach, vi } from "vitest";

// notify() touches window.setTimeout; stub the notify module so the store tests
// stay pure and don't depend on a DOM.
vi.mock("@/shared/lib/system/notify-store", () => ({
  notify: vi.fn(() => "noticed"),
}));

import {
  getDownloads,
  getActiveDownloadCount,
  startDownload,
  updateDownloadProgress,
  finishDownload,
  failDownload,
  cancelDownload,
  clearDownloadHistory,
} from "@files/application/commands/download-store";

// The store is module-global; clear finished entries between tests. Active ones
// are cleared by finishing+clearing.
beforeEach(() => {
  // Finish then clear anything left active from a previous test.
  for (const d of getDownloads()) {
    if (d.status === "active") finishDownload(d.id);
  }
  clearDownloadHistory();
});

describe("download-store", () => {
  it("adds an active download and counts it", () => {
    const id = startDownload("a.txt");
    expect(getActiveDownloadCount()).toBe(1);
    const item = getDownloads().find((d) => d.id === id);
    expect(item?.status).toBe("active");
    expect(item?.name).toBe("a.txt");
  });

  it("updates progress only while active", () => {
    const id = startDownload("b.zip", 1000);
    updateDownloadProgress(id, 500, 1000, 250);
    let item = getDownloads().find((d) => d.id === id);
    expect(item?.loaded).toBe(500);
    expect(item?.speed).toBe(250);

    finishDownload(id);
    updateDownloadProgress(id, 999, 1000, 999); // ignored — not active
    item = getDownloads().find((d) => d.id === id);
    expect(item?.loaded).toBe(500);
    expect(item?.status).toBe("done");
  });

  it("finish sets total from loaded when total was unknown", () => {
    const id = startDownload("c.bin", 0);
    updateDownloadProgress(id, 4096, 0, 100);
    finishDownload(id);
    const item = getDownloads().find((d) => d.id === id);
    expect(item?.total).toBe(4096);
    expect(getActiveDownloadCount()).toBe(0);
  });

  it("records failures with a message", () => {
    const id = startDownload("d.pdf");
    failDownload(id, "network lost");
    const item = getDownloads().find((d) => d.id === id);
    expect(item?.status).toBe("error");
    expect(item?.error).toBe("network lost");
  });

  it("cancel only affects active downloads", () => {
    const id = startDownload("e.mov");
    cancelDownload(id);
    expect(getDownloads().find((d) => d.id === id)?.status).toBe("canceled");
    // Cancelling again is a no-op.
    cancelDownload(id);
    expect(getDownloads().find((d) => d.id === id)?.status).toBe("canceled");
  });

  it("clearDownloadHistory keeps active, removes finished", () => {
    const active = startDownload("keep.txt");
    const done = startDownload("gone.txt");
    finishDownload(done);

    clearDownloadHistory();

    const ids = getDownloads().map((d) => d.id);
    expect(ids).toContain(active);
    expect(ids).not.toContain(done);
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { UploadQueue, type UploadItem } from "@files/application/commands/upload-queue";

/**
 * These exercise the working-window mechanics through the public API: the real
 * fetch is stubbed, and every batch-init reply reports `status: "completed"` so
 * the full lifecycle — claim, markDone, publish, prune, refill — runs without a
 * single PUT (putBlob needs XMLHttpRequest, which Node does not have).
 *
 * The window cap is asserted as 500 rather than imported: MAX_LIVE_ITEMS is a
 * tuning constant, and a test that reads it can only ever agree with the code.
 * If the constant changes, this number is meant to be updated by hand.
 */
const EXPECTED_WINDOW = 500;
const FILE_BYTES = 1024;

function makeFile(name: string): File {
  return new File([new Uint8Array(FILE_BYTES)], name, { type: "text/plain" });
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

type InitRequestEntry = { filename: string; sizeBytes: number };

/** batch-init that either completes every file or refuses every file. */
function stubUploadApi(refuse: boolean) {
  let batch = 0;
  return vi.fn(async (input: string | URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/csrf") return jsonResponse({ data: { token: "test-csrf" } });
    if (url === "/api/uploads/batch-init") {
      const body = JSON.parse(String(init?.body)) as { files: InitRequestEntry[] };
      batch++;
      return jsonResponse({
        success: true,
        data: {
          results: body.files.map((file, index) =>
            refuse
              ? { index, ok: false, error: "BLOCKED_BY_POLICY", code: "BLOCKED_BY_POLICY" }
              : {
                  index,
                  ok: true,
                  sessionId: `s-${batch}-${index}`,
                  fileId: `f-${batch}-${index}`,
                  status: "completed",
                  totalSizeBytes: file.sizeBytes,
                  uploadUrl: null,
                  uploadType: "single",
                  partCount: 1,
                  partSizeBytes: null,
                  uploadId: null,
                }
          ),
        },
      });
    }
    return jsonResponse({ success: false, error: "UNEXPECTED_ENDPOINT" }, 404);
  });
}

function settle(queue: UploadQueue, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("allComplete never fired")), timeoutMs);
    queue.on("allComplete", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Lets any pending notify timer (the one that runs pruneFinished) flush. */
async function flushNotify() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("UploadQueue working window", () => {
  let queues: UploadQueue[] = [];

  function newQueue(): UploadQueue {
    const queue = new UploadQueue(null);
    queues.push(queue);
    return queue;
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", stubUploadApi(false));
  });

  afterEach(() => {
    for (const queue of queues) queue.dispose();
    queues = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("holds at most EXPECTED_WINDOW live items, the rest wait in the backlog", () => {
    const queue = newQueue();
    const files = Array.from({ length: 600 }, (_, index) => makeFile(`f${index}.txt`));
    queue.addFiles(files);

    // The window is promoted synchronously; the backlog holds the remainder.
    const items = queue.getItems();
    expect(items.length).toBe(EXPECTED_WINDOW);
    // But the whole upload is still accounted for.
    const stats = queue.getStats();
    expect(stats.total).toBe(600);
    expect(stats.totalBytes).toBe(600 * FILE_BYTES);
  });

  it("drains a backlog larger than the window to completion", async () => {
    const queue = newQueue();
    const done = settle(queue);
    queue.addFiles(Array.from({ length: 600 }, (_, index) => makeFile(`f${index}.txt`)));
    await done;
    await flushNotify();

    const stats = queue.getStats();
    expect(stats.completed).toBe(600);
    expect(stats.failed).toBe(0);
    expect(stats.active).toBe(0);
    expect(stats.queued).toBe(0);
    // Pruned rows are gone from the window entirely — that is the point.
    expect(queue.getItems().length).toBe(0);
  });

  it("keeps stats accurate after rows are pruned", async () => {
    const queue = newQueue();
    const done = settle(queue);
    queue.addFiles(Array.from({ length: 600 }, (_, index) => makeFile(`f${index}.txt`)));
    await done;
    await flushNotify();

    const stats = queue.getStats();
    expect(stats.total).toBe(600);
    expect(stats.totalBytes).toBe(600 * FILE_BYTES);
    // Every file "completed" without a PUT, so loaded equals total.
    expect(stats.loadedBytes).toBe(600 * FILE_BYTES);
    expect(stats.overallProgress).toBe(100);
  });

  it("releases the File handle once an item is done", async () => {
    const queue = newQueue();
    const finished: UploadItem[] = [];
    queue.on("complete", (item) => finished.push(item));

    const done = settle(queue);
    queue.addFiles(Array.from({ length: 50 }, (_, index) => makeFile(`f${index}.txt`)));
    await done;

    expect(finished.length).toBe(50);
    // markDone nulls the handle after emitting; none of them may still hold one.
    for (const item of finished) expect(item.file).toBeNull();
  });

  it("retains recent failures for retry and retires only the overflow", async () => {
    vi.stubGlobal("fetch", stubUploadApi(true));
    const queue = newQueue();
    const done = settle(queue);
    queue.addFiles(Array.from({ length: 45 }, (_, index) => makeFile(`f${index}.txt`)));
    await done;
    await flushNotify();

    const items = queue.getItems();
    const errors = items.filter((item) => item.status === "error");
    // The newest failures keep their handle so the retry button works.
    expect(errors.length).toBe(40);
    for (const item of errors) expect(item.file).not.toBeNull();
    // The overflow retired instead — but the totals still count all 45.
    const stats = queue.getStats();
    expect(stats.failed).toBe(45);
    expect(stats.total).toBe(45);

    // And the retained ones really are retryable — back in the work loop
    // ("preparing" is claimed synchronously inside processNext).
    queue.retryFailed();
    const requeued = queue.getItems().filter((item) => item.status === "queued" || item.status === "preparing");
    expect(requeued.length).toBe(40);
  });

  it("cancelAll drops the backlog so a cancelled folder does not restart", async () => {
    const queue = newQueue();
    queue.addFiles(Array.from({ length: 600 }, (_, index) => makeFile(`f${index}.txt`)));
    queue.cancelAll();
    await flushNotify();

    // The backlog is gone and nothing queued remains, so no refill can promote
    // any of the 600 files the user just cancelled. (Items already claimed by an
    // in-flight batch are deliberately not interrupted — that is existing
    // behaviour, not what this asserts.)
    expect(queue.getStats().queued).toBe(0);
    for (const item of queue.getItems()) expect(item.status).not.toBe("queued");
  });
});

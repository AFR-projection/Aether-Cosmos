import { describe, it, expect } from "vitest";
import { Readable } from "stream";
import JSZip from "jszip";
import {
  ARCHIVE_ENTRY_MAX_BYTES,
  ARCHIVE_INSPECT_MAX_BYTES,
  ArchiveEntryTooLargeError,
  ArchiveTooLargeError,
  archiveErrorResponse,
  archiveTooLargeResponse,
  declaredEntrySize,
  readArchiveBuffer,
  readEntryBounded,
} from "@/lib/storage/archive-read";

/**
 * Looking inside an archive used to be unbounded in two independent ways: the
 * container was drained into one `Buffer` with no ceiling, and a single entry was
 * decompressed with `entry.async()`, also with no ceiling. Either one turns a
 * normal request into an out-of-memory kill of the shared Node process — the
 * second reachable with only a few MB of upload (a decompression bomb).
 *
 * These tests hold both ceilings, and specifically hold them against a *lying*
 * input: an R2 body longer than the row says, and a ZIP entry whose declared
 * uncompressed size is far below what actually comes out of the inflater.
 */

/** A web ReadableStream of the given chunks, reporting whether it was cancelled. */
function webStream(chunks: Uint8Array[], state = { cancelled: false }) {
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i++]);
      } else {
        controller.close();
      }
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** A web ReadableStream that never ends — what an attacker-sized object looks like. */
function endlessWebStream(state = { cancelled: false }) {
  const chunk = new Uint8Array(64 * 1024).fill(0x41);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

function bytes(n: number, fill = 0x42) {
  return new Uint8Array(n).fill(fill);
}

describe("readArchiveBuffer — web ReadableStream", () => {
  it("returns the whole body when it fits", async () => {
    const { stream } = webStream([bytes(10, 1), bytes(6, 2)]);
    const buffer = await readArchiveBuffer(stream, 1024);
    expect(buffer.length).toBe(16);
    expect(buffer[0]).toBe(1);
    expect(buffer[15]).toBe(2);
  });

  it("accepts a body exactly at the ceiling", async () => {
    const { stream } = webStream([bytes(32), bytes(32)]);
    await expect(readArchiveBuffer(stream, 64)).resolves.toHaveLength(64);
  });

  it("refuses one byte past the ceiling", async () => {
    const { stream } = webStream([bytes(32), bytes(33)]);
    await expect(readArchiveBuffer(stream, 64)).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });

  it("stops reading instead of buffering an endless body", async () => {
    const { stream, state } = endlessWebStream();
    await expect(readArchiveBuffer(stream, 256 * 1024)).rejects.toBeInstanceOf(
      ArchiveTooLargeError
    );
    // The transfer is abandoned; the rest of the object never arrives.
    expect(state.cancelled).toBe(true);
  });

  it("reports the ceiling it enforced", async () => {
    const { stream } = webStream([bytes(100)]);
    await expect(readArchiveBuffer(stream, 10)).rejects.toMatchObject({ maxBytes: 10 });
  });
});

describe("readArchiveBuffer — Node stream", () => {
  it("returns the whole body when it fits", async () => {
    const node = Readable.from([Buffer.from([1, 2, 3]), Buffer.from([4, 5])]);
    const buffer = await readArchiveBuffer(node, 1024);
    expect([...buffer]).toEqual([1, 2, 3, 4, 5]);
  });

  it("refuses past the ceiling and destroys the stream", async () => {
    const node = Readable.from([bytes(40), bytes(40)]);
    await expect(readArchiveBuffer(node, 64)).rejects.toBeInstanceOf(ArchiveTooLargeError);
    expect(node.destroyed).toBe(true);
  });

  it("does not care what the database said the size was — it counts", async () => {
    // The row can claim 1 KB while R2 hands back far more (declared sizes are
    // uploader-supplied on the legacy presign path).
    const node = Readable.from([bytes(1024), bytes(1024), bytes(1024)]);
    await expect(readArchiveBuffer(node, 2048)).rejects.toBeInstanceOf(ArchiveTooLargeError);
  });

  it("rejects a body that is neither stream shape", async () => {
    await expect(readArchiveBuffer({ nope: true })).rejects.toBeInstanceOf(TypeError);
    await expect(readArchiveBuffer(null)).rejects.toBeInstanceOf(TypeError);
  });
});

describe("readEntryBounded", () => {
  async function zipWith(entries: Record<string, Uint8Array | string>) {
    const zip = new JSZip();
    for (const [name, data] of Object.entries(entries)) {
      zip.file(name, data);
    }
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    return JSZip.loadAsync(buffer);
  }

  it("returns a small entry unchanged", async () => {
    const zip = await zipWith({ "a.txt": "hello archive" });
    const out = await readEntryBounded(zip.file("a.txt")!, 1024);
    expect(Buffer.from(out).toString()).toBe("hello archive");
  });

  it("accepts an entry exactly at the ceiling", async () => {
    const zip = await zipWith({ "a.bin": bytes(512) });
    await expect(readEntryBounded(zip.file("a.bin")!, 512)).resolves.toHaveLength(512);
  });

  it("refuses an entry over the ceiling", async () => {
    const zip = await zipWith({ "a.bin": bytes(2048) });
    await expect(readEntryBounded(zip.file("a.bin")!, 512)).rejects.toBeInstanceOf(
      ArchiveEntryTooLargeError
    );
  });

  it("refuses a compression bomb — small on disk, huge inflated", async () => {
    // 8 MiB of zeroes deflates to a few KB. Unbounded, this is how a few MB of
    // upload becomes gigabytes of resident memory once the entry is repeated.
    const zip = await zipWith({ "bomb.bin": new Uint8Array(8 * 1024 * 1024) });
    const entry = zip.file("bomb.bin")!;
    await expect(readEntryBounded(entry, 64 * 1024)).rejects.toBeInstanceOf(
      ArchiveEntryTooLargeError
    );
  });

  it("still refuses when the entry lies about its declared size", async () => {
    const zip = await zipWith({ "a.bin": bytes(4096) });
    const entry = zip.file("a.bin")!;
    // A crafted central directory can claim anything; the real limit has to be
    // applied to the bytes leaving the inflater, not to this number.
    Object.defineProperty(entry, "uncompressedSize", { value: 1, configurable: true });
    (entry as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize = 1;
    expect(declaredEntrySize(entry)).toBe(1);
    await expect(readEntryBounded(entry, 512)).rejects.toBeInstanceOf(
      ArchiveEntryTooLargeError
    );
  });

  it("rejects on the declared size before decompressing anything", async () => {
    const zip = await zipWith({ "a.bin": bytes(4096) });
    const entry = zip.file("a.bin")!;
    // `internalStream` is real at runtime but absent from JSZip's typings.
    const spied = entry as unknown as { internalStream: (t: string) => unknown };
    let opened = false;
    const original = spied.internalStream.bind(spied);
    spied.internalStream = (type: string) => {
      opened = true;
      return original(type);
    };

    await expect(readEntryBounded(entry, 64)).rejects.toBeInstanceOf(ArchiveEntryTooLargeError);
    expect(opened).toBe(false);
  });

  it("propagates a real decompression failure instead of masking it", async () => {
    const zip = await zipWith({ "a.bin": bytes(256) });
    const entry = zip.file("a.bin")!;
    // Corrupt the compressed payload so the inflater errors.
    const data = (entry as unknown as { _data: { compressedContent: Uint8Array } })._data;
    data.compressedContent = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(readEntryBounded(entry, 1024)).rejects.not.toBeInstanceOf(
      ArchiveEntryTooLargeError
    );
  });

  it("reassembles multi-chunk output in order", async () => {
    const payload = Buffer.alloc(300 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const zip = await zipWith({ "big.bin": new Uint8Array(payload) });
    const out = await readEntryBounded(zip.file("big.bin")!, 1024 * 1024);
    expect(Buffer.from(out).equals(payload)).toBe(true);
  });
});

describe("declaredEntrySize", () => {
  it("returns null when nothing usable is declared", () => {
    expect(declaredEntrySize({} as never)).toBeNull();
    expect(declaredEntrySize({ uncompressedSize: NaN } as never)).toBeNull();
    expect(declaredEntrySize({ uncompressedSize: "big" } as never)).toBeNull();
  });

  it("falls back to the internal data record", () => {
    expect(declaredEntrySize({ _data: { uncompressedSize: 42 } } as never)).toBe(42);
  });
});

describe("error responses", () => {
  it("maps the container error to a 413 with a code", async () => {
    const response = archiveErrorResponse(new ArchiveTooLargeError(123))!;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "ARCHIVE_TOO_LARGE",
      maxBytes: 123,
    });
  });

  it("maps the entry error to its own code", async () => {
    const response = archiveErrorResponse(new ArchiveEntryTooLargeError(7))!;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "ARCHIVE_ENTRY_TOO_LARGE",
      maxBytes: 7,
    });
  });

  it("returns null for anything else, so the route rethrows", () => {
    expect(archiveErrorResponse(new Error("boom"))).toBeNull();
    expect(archiveErrorResponse("boom")).toBeNull();
    expect(archiveErrorResponse(undefined)).toBeNull();
  });

  it("defaults the ready-made refusal to the inspect ceiling", async () => {
    const response = archiveTooLargeResponse();
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      maxBytes: ARCHIVE_INSPECT_MAX_BYTES,
    });
  });
});

describe("the ceilings themselves", () => {
  it("bounds an entry more tightly than the container", () => {
    expect(ARCHIVE_ENTRY_MAX_BYTES).toBeLessThanOrEqual(ARCHIVE_INSPECT_MAX_BYTES);
    expect(ARCHIVE_INSPECT_MAX_BYTES).toBeGreaterThan(0);
  });
});

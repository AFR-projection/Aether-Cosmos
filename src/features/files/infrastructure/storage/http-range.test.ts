import { describe, it, expect } from "vitest";
import { Readable } from "node:stream";
import {
  isContinuationRange,
  parseRangeHeader,
  rangeLength,
  toReadableStream,
} from "@files/infrastructure/storage/http-range";

/**
 * The parser the two byte-serving preview routes share.
 *
 * The public one (`/api/shared/[token]/preview`) used to read the `Range` header
 * only to decide whether to charge the share's access budget, and then serve the
 * whole object with a `200`. So these two questions — "is this a continuation?"
 * and "what will actually be sent?" — had different answers, and the gap between
 * them was a free download.
 */

const SIZE = 4096;

describe("parseRangeHeader", () => {
  it("distinguishes an absent header from an invalid one", () => {
    expect(parseRangeHeader(null, SIZE)).toEqual({ kind: "none" });
    expect(parseRangeHeader("", SIZE)).toEqual({ kind: "malformed" });
  });

  it("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-1023", SIZE)).toEqual({
      kind: "range",
      range: { start: 0, end: 1023, byteRange: "bytes=0-1023" },
    });
  });

  it("parses open-ended and suffix ranges", () => {
    expect(parseRangeHeader("bytes=1024-", SIZE)).toEqual({
      kind: "range",
      range: { start: 1024, end: SIZE - 1, byteRange: `bytes=1024-${SIZE - 1}` },
    });
    expect(parseRangeHeader("bytes=-500", SIZE)).toEqual({
      kind: "range",
      range: {
        start: SIZE - 500,
        end: SIZE - 1,
        byteRange: `bytes=${SIZE - 500}-${SIZE - 1}`,
      },
    });
  });

  it("clamps an end past the object", () => {
    const parsed = parseRangeHeader("bytes=4000-99999", SIZE);
    expect(parsed.kind === "range" ? parsed.range.end : null).toBe(SIZE - 1);
  });

  it("tolerates surrounding whitespace and a capitalised unit", () => {
    const parsed = parseRangeHeader("  BYTES=0-9  ", SIZE);
    expect(parsed.kind === "range" ? parsed.range.byteRange : null).toBe("bytes=0-9");
  });

  it("marks a start at or past EOF as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=4096-", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=99999-", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("marks an inverted or empty suffix range as unsatisfiable", () => {
    expect(parseRangeHeader("bytes=200-100", SIZE)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-0", SIZE)).toEqual({ kind: "unsatisfiable" });
  });

  it("marks unsupported or invalid syntax as malformed", () => {
    for (const header of [
      "bytes=0-99,200-299",
      "items=0-99",
      "bytes=",
      "bytes=-",
      "bytes=abc-def",
    ]) {
      expect(parseRangeHeader(header, SIZE), JSON.stringify(header)).toEqual({
        kind: "malformed",
      });
    }
  });

  it("cannot satisfy a range when the object size is unknown", () => {
    expect(parseRangeHeader("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-", NaN)).toEqual({ kind: "unsatisfiable" });
  });
});

describe("rangeLength", () => {
  it("counts both endpoints", () => {
    expect(rangeLength({ start: 0, end: 0, byteRange: "bytes=0-0" })).toBe(1);
    expect(rangeLength({ start: 100, end: 199, byteRange: "bytes=100-199" })).toBe(100);
  });
});

describe("isContinuationRange", () => {
  function usable(header: string) {
    const result = parseRangeHeader(header, SIZE);
    return result.kind === "range" ? result.range : null;
  }

  it("treats a range starting past byte 0 as a resume", () => {
    expect(isContinuationRange(usable("bytes=1-"))).toBe(true);
    expect(isContinuationRange(usable("bytes=-500"))).toBe(true);
  });

  it("does not treat a chunked fresh start as a resume", () => {
    expect(isContinuationRange(usable("bytes=0-1023"))).toBe(false);
  });

  it("is false when there is no usable range at all", () => {
    expect(isContinuationRange(null)).toBe(false);
    expect(isContinuationRange(usable("bytes=99999-"))).toBe(false);
  });
});

/**
 * Streaming a range without pulling it into memory.
 *
 * The first version of {@link toReadableStream} attached a `data` listener and enqueued every chunk
 * the moment it arrived, with nothing consulting the consumer. That is not a stream, it is a copy:
 * a `bytes=0-` request for a 123 MB video pulled all 123 MB into the controller's queue before the
 * browser had read the second chunk. On a 2 GB box running the app, the worker, nginx and Redis,
 * that is enough GC pressure to stall the event loop — and a stalled event loop delays every OTHER
 * request too, which is how one large video made the whole app feel broken.
 *
 * So the test that matters is not "does it deliver the bytes" but "does it stop when nobody is
 * reading". A stream honouring backpressure leaves the source paused until the consumer pulls.
 */
describe("toReadableStream backpressure", () => {
  /** A Node stream that records whether it was allowed to keep pushing. */
  function countingSource(chunks: number) {
    let produced = 0;
    const stream = new Readable({
      // 1 byte, so the Node-side buffer cannot mask a missing pull.
      highWaterMark: 1,
      read() {
        if (produced >= chunks) {
          this.push(null);
          return;
        }
        produced += 1;
        this.push(new Uint8Array(16));
      },
    });
    return { stream, produced: () => produced };
  }

  it("does not drain the source before the consumer reads", async () => {
    const { stream, produced } = countingSource(500);
    const web = toReadableStream(stream);
    // Give the event loop room to run any eager listeners the implementation might have attached.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(produced()).toBeLessThan(50);
    await web.cancel();
  });

  it("still delivers every byte when the consumer does read", async () => {
    const { stream } = countingSource(10);
    const reader = toReadableStream(stream).getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
    expect(total).toBe(10 * 16);
  });

  it("passes a web stream through untouched", () => {
    const web = new ReadableStream();
    expect(toReadableStream(web)).toBe(web);
  });
});

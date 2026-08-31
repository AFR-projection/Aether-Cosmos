import { describe, it, expect } from "vitest";
import {
  readBoundedText,
  readBoundedJson,
  bodyErrorResponse,
  BodyTooLargeError,
  BodyInvalidJsonError,
} from "./body";

/**
 * The body reader exists because `request.json()` buffers whatever arrives, and
 * some of the routes that call it (the shared-note editor) are reachable without
 * a session. What is pinned here is that the ceiling holds in the two ways a
 * sender can lie about size: a false `content-length`, and no `content-length`
 * at all with a stream that keeps going.
 */

/** A minimal stand-in for `Request` — enough surface for the reader. */
function fakeRequest(
  chunks: (string | Uint8Array)[] | null,
  headers: Record<string, string> = {},
  onCancel?: () => void
): Request {
  const encoder = new TextEncoder();
  let index = 0;

  const body =
    chunks === null
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (index >= chunks.length) {
              controller.close();
              return;
            }
            const chunk = chunks[index++];
            controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
          },
          cancel() {
            onCancel?.();
          },
        });

  return { headers: new Headers(headers), body } as unknown as Request;
}

/** A stream that never ends — the shape of the attack, not a fixed payload. */
function endlessRequest(onCancel?: () => void): Request {
  const filler = new TextEncoder().encode("x".repeat(64 * 1024));
  return {
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(filler.slice());
      },
      cancel() {
        onCancel?.();
      },
    }),
  } as unknown as Request;
}

describe("readBoundedText", () => {
  it("returns the body when it fits", async () => {
    const text = await readBoundedText(fakeRequest(["hello ", "world"]), 1024);
    expect(text).toBe("hello world");
  });

  it("returns empty string when there is no body at all", async () => {
    expect(await readBoundedText(fakeRequest(null), 1024)).toBe("");
  });

  it("rejects early on a declared content-length over the cap", async () => {
    let read = false;
    const request = fakeRequest(["ignored"], { "content-length": "5000" });
    // Wrap the stream so we can prove it was never pulled.
    const original = request.body!;
    Object.defineProperty(request, "body", {
      get() {
        read = true;
        return original;
      },
    });

    await expect(readBoundedText(request, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(read).toBe(false);
  });

  it("does not trust a small declared content-length — the stream is still measured", async () => {
    // A chunked sender can claim anything, or nothing. 8 bytes declared, 20 sent.
    const request = fakeRequest(["a".repeat(20)], { "content-length": "8" });
    await expect(readBoundedText(request, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("stops an endless stream instead of buffering it", async () => {
    let cancelled = false;
    const request = endlessRequest(() => {
      cancelled = true;
    });

    await expect(readBoundedText(request, 128 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(cancelled).toBe(true);
  });

  it("accepts a body exactly at the ceiling", async () => {
    const text = await readBoundedText(fakeRequest(["abcde"]), 5);
    expect(text).toBe("abcde");
  });

  it("counts bytes, not characters, and still decodes a split code point", async () => {
    // "é" is two bytes; splitting it across chunks must not corrupt the text.
    const bytes = new TextEncoder().encode("é");
    const text = await readBoundedText(
      fakeRequest([bytes.slice(0, 1), bytes.slice(1)]),
      1024
    );
    expect(text).toBe("é");

    // Same two bytes against a one-byte ceiling: too large, even though it is
    // a single character.
    await expect(
      readBoundedText(fakeRequest([bytes.slice(0, 1), bytes.slice(1)]), 1)
    ).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("reports the ceiling it enforced", async () => {
    const error = await readBoundedText(fakeRequest(["abc"]), 2).catch((e) => e);
    expect(error).toBeInstanceOf(BodyTooLargeError);
    expect((error as BodyTooLargeError).maxBytes).toBe(2);
  });
});

describe("readBoundedJson", () => {
  it("parses a body that fits", async () => {
    const value = await readBoundedJson<{ content: { type: string } }>(
      fakeRequest(['{"content":', '{"type":"doc"}}']),
      1024
    );
    expect(value.content.type).toBe("doc");
  });

  it("throws BodyInvalidJsonError on a malformed body", async () => {
    await expect(readBoundedJson(fakeRequest(["{nope"]), 1024)).rejects.toBeInstanceOf(
      BodyInvalidJsonError
    );
  });

  it("throws BodyInvalidJsonError on an empty body", async () => {
    await expect(readBoundedJson(fakeRequest(null), 1024)).rejects.toBeInstanceOf(
      BodyInvalidJsonError
    );
  });

  it("prefers the size error over the parse error", async () => {
    // An oversized body is never parsed, so the caller gets 413, not 400.
    await expect(readBoundedJson(fakeRequest(["{nope-and-far-too-long"]), 4)).rejects.toBeInstanceOf(
      BodyTooLargeError
    );
  });
});

describe("bodyErrorResponse", () => {
  it("maps an oversized body to 413 BODY_TOO_LARGE", async () => {
    const response = bodyErrorResponse(new BodyTooLargeError(10));
    expect(response?.status).toBe(413);
    expect(await response!.json()).toMatchObject({ success: false, code: "BODY_TOO_LARGE" });
  });

  it("maps invalid JSON to 400 INVALID_JSON", async () => {
    const response = bodyErrorResponse(new BodyInvalidJsonError());
    expect(response?.status).toBe(400);
    expect(await response!.json()).toMatchObject({ success: false, code: "INVALID_JSON" });
  });

  it("returns null for anything else so the caller rethrows", () => {
    expect(bodyErrorResponse(new Error("boom"))).toBeNull();
    expect(bodyErrorResponse("nope")).toBeNull();
  });

  it("never echoes the body back to the caller", async () => {
    const response = bodyErrorResponse(new BodyTooLargeError(10));
    const text = await response!.text();
    expect(text).not.toMatch(/x{10}/);
  });
});

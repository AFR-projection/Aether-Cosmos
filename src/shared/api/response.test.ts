import { describe, it, expect, vi, afterEach } from "vitest";
import { z } from "zod";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import { AuthError } from "@/shared/lib/auth/session";
import { BrainError } from "@brain/domain/errors";
import { UploadServiceError } from "@files/infrastructure/storage/upload-service";
import {
  BodyInvalidJsonError,
  BodyTooLargeError,
  readBoundedJson as readBoundedJsonUnbounded,
} from "@/shared/api/read-body";
import * as boundedBody from "@/shared/api/body";

/**
 * `handleApiError` is the last line of every route's `catch`, so whatever it does
 * not recognise becomes a 500 with a logged stack — and a 500 is a claim that the
 * server is broken. Two classes of caller mistake were being reported that way:
 *
 *  - a path segment that is not a UUID reached a `uuid` column, and Postgres
 *    answered SQLSTATE 22P02. `GET /api/webhooks/banana` was a 500.
 *  - `BodyTooLargeError` existed TWICE, declared in both `src/shared/api/body.ts` and
 *    `src/shared/api/read-body.ts`. `instanceof` compares identity, so the 413 branch
 *    only matched one of them and a route using the other reader answered 500 for
 *    an oversized body — the opposite of the refusal it was written to perform.
 *
 * The identity tests below are the ones that would catch a re-split: they assert
 * the two module paths export the same class object, not merely the same name.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

async function payload(response: Response) {
  return (await response.json()) as Record<string, unknown>;
}

/** A postgres.js error carries its SQLSTATE on `.code`. */
function pgError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(`postgres said ${code}`), { code, ...extra });
}

describe("apiSuccess / apiError", () => {
  it("wraps data and sets the security headers", async () => {
    const response = apiSuccess({ id: "abc" });
    expect(response.status).toBe(200);
    expect(await payload(response)).toEqual({ success: true, data: { id: "abc" } });
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("spreads extras into the error body", async () => {
    const response = apiError("nope", 403, { code: "FORBIDDEN", reason: "scope" });
    expect(response.status).toBe(403);
    expect(await payload(response)).toEqual({
      success: false,
      error: "nope",
      code: "FORBIDDEN",
      reason: "scope",
    });
  });
});

describe("handleApiError — body errors", () => {
  it("maps an oversized body to 413 and says what the ceiling was", async () => {
    const response = handleApiError(new BodyTooLargeError(64 * 1024));
    expect(response.status).toBe(413);
    expect(await payload(response)).toMatchObject({
      code: "BODY_TOO_LARGE",
      maxBytes: 65536,
    });
  });

  it("maps an unparseable body to 400", async () => {
    const response = handleApiError(new BodyInvalidJsonError());
    expect(response.status).toBe(400);
    expect(await payload(response)).toMatchObject({ code: "INVALID_JSON" });
  });

  it("maps the SyntaxError that `request.json()` throws to 400", async () => {
    let thrown: unknown;
    try {
      JSON.parse("{ not json");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
    const response = handleApiError(thrown);
    expect(response.status).toBe(400);
    expect(await payload(response)).toMatchObject({ code: "INVALID_JSON" });
  });

  it("does not turn every SyntaxError into a client error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = handleApiError(new SyntaxError("unexpected token in template"));
    expect(response.status).toBe(500);
  });

  describe("there is exactly one class per name", () => {
    it("both body modules export the same classes", () => {
      expect(boundedBody.BodyTooLargeError).toBe(BodyTooLargeError);
      expect(boundedBody.BodyInvalidJsonError).toBe(BodyInvalidJsonError);
    });

    it("an oversized body read through @/shared/api/body still reaches the 413 branch", async () => {
      const request = new Request("https://example.test/api/anything", {
        method: "POST",
        body: JSON.stringify({ note: "x".repeat(200) }),
      });

      let thrown: unknown;
      try {
        await boundedBody.readBoundedJson(request, 32);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(BodyTooLargeError);
      expect(handleApiError(thrown).status).toBe(413);
    });

    it("an oversized body read through @/shared/api/read-body reaches it too", async () => {
      const request = new Request("https://example.test/api/anything", {
        method: "POST",
        body: "y".repeat(500),
      });

      let thrown: unknown;
      try {
        await readBoundedJsonUnbounded(request, 32);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(BodyTooLargeError);
      expect(handleApiError(thrown).status).toBe(413);
    });

    it("a malformed body read through @/shared/api/body reaches the 400 branch", async () => {
      const request = new Request("https://example.test/api/anything", {
        method: "POST",
        body: "{ definitely not json",
      });

      let thrown: unknown;
      try {
        await boundedBody.readBoundedJson(request, 1024);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(BodyInvalidJsonError);
      const response = handleApiError(thrown);
      expect(response.status).toBe(400);
      expect(await payload(response)).toMatchObject({ code: "INVALID_JSON" });
    });
  });
});

describe("handleApiError — typed application errors", () => {
  it("keeps an UploadServiceError's own status and code", async () => {
    const response = handleApiError(new UploadServiceError("QUOTA", "Out of space", 402));
    expect(response.status).toBe(402);
    expect(await payload(response)).toMatchObject({ error: "Out of space", code: "QUOTA" });
  });

  it("keeps a BrainError's own status and code", async () => {
    const response = handleApiError(new BrainError("Brain not found", 404, "BRAIN_NOT_FOUND"));
    expect(response.status).toBe(404);
    expect(await payload(response)).toMatchObject({ code: "BRAIN_NOT_FOUND" });
  });

  it("carries an AuthError's IP evidence through", async () => {
    const error = new AuthError("Session moved", 401, "IP_CHANGED", {
      previousIp: "203.0.113.7",
      currentIp: "198.51.100.4",
    });
    const response = handleApiError(error);
    expect(response.status).toBe(401);
    expect(await payload(response)).toMatchObject({
      code: "IP_CHANGED",
      previousIp: "203.0.113.7",
      currentIp: "198.51.100.4",
    });
  });

  it("omits the optional AuthError fields when they are absent", async () => {
    const response = handleApiError(new AuthError("Unauthorized"));
    expect(response.status).toBe(401);
    expect(await payload(response)).toEqual({ success: false, error: "Unauthorized" });
  });

  it("names the offending field for a ZodError", async () => {
    const schema = z.object({ profile: z.object({ email: z.string().email() }) });
    let thrown: unknown;
    try {
      schema.parse({ profile: { email: "not-an-email" } });
    } catch (e) {
      thrown = e;
    }
    const response = handleApiError(thrown);
    expect(response.status).toBe(400);
    const body = await payload(response);
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(String(body.error)).toContain("profile.email");
  });
});

describe("handleApiError — Postgres SQLSTATEs", () => {
  it("turns a unique violation into a 409 that names the field", async () => {
    const response = handleApiError(pgError("23505", { constraint: "users_email_unique" }));
    expect(response.status).toBe(409);
    const body = await payload(response);
    expect(body.code).toBe("DUPLICATE");
    expect(String(body.error)).toMatch(/email/i);
  });

  it("reads the SQLSTATE off `cause` when the driver wraps it", async () => {
    const wrapped = Object.assign(new Error("insert failed"), {
      cause: { code: "23505", constraint: "users_username_unique" },
    });
    const response = handleApiError(wrapped);
    expect(response.status).toBe(409);
    expect(String((await payload(response)).error)).toMatch(/username/i);
  });

  it("falls back to a generic duplicate message for an unknown constraint", async () => {
    const response = handleApiError(pgError("23505", { constraint: "some_other_idx" }));
    expect(response.status).toBe(409);
    expect(String((await payload(response)).error)).toMatch(/already in use/i);
  });

  it("answers 400 for an id that is not a UUID, instead of 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = handleApiError(
      pgError("22P02", { message: 'invalid input syntax for type uuid: "banana"' })
    );
    expect(response.status).toBe(400);
    expect(await payload(response)).toMatchObject({
      error: "Malformed identifier",
      code: "INVALID_ID",
    });
  });

  it("still logs 22P02 — the same code comes from a bad server-side cast", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    handleApiError(pgError("22P02"));
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("does not echo the database's own message on the 400", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = handleApiError(
      pgError("22P02", { table: "webhooks", column: "id", routine: "string_to_uuid" })
    );
    const body = JSON.stringify(await payload(response));
    expect(body).not.toMatch(/webhooks|string_to_uuid|postgres said/);
  });
});

describe("handleApiError — the fallback", () => {
  it("answers a bare 500 and leaks nothing from the thrown error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = handleApiError(
      pgError("42P01", { message: 'relation "secret_internal_table" does not exist' })
    );
    expect(response.status).toBe(500);
    expect(await payload(response)).toEqual({
      success: false,
      error: "Internal server error",
    });
  });

  it("survives a thrown non-Error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const value of [null, undefined, "boom", 42, { code: 23505 }]) {
      const response = handleApiError(value);
      expect(response.status).toBe(500);
    }
  });
});

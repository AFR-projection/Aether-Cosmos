/**
 * A cut-short upload says so — and nothing else is allowed to.
 *
 * `POST /api/backup/restore` reads the archive as a stream, so the reader meets a truncated upload
 * as a file whose last 80 bytes are missing: the trailer check fails and §12 requires that to be
 * answered with one deliberately vague sentence, "the recovery phrase is wrong, or the file is
 * damaged". That sentence is right about a stolen archive and wrong about a dropped connection,
 * and the difference cost real time once — Next's proxy cloned the body at its 10 MB cap
 * (`tests/proxy-restore-body.test.ts`), so a 40 MB archive arrived as 10 MB of intact prefix and
 * the user was told to go and re-read nine words that had been correct all along.
 *
 * The route can tell the two apart because it knows something the reader does not: the
 * `Content-Length` the *sender* set. A body that ended cleanly, short of its own stated length,
 * was cut in transit. That is not an oracle — both numbers came from the caller — so this is the
 * one place a refusal may be more specific than §12's sentence.
 *
 * Three properties make it safe, and each has a test below:
 *
 *   1. It fires only when the body reached EOF. A reader that stops early — a wrong phrase found
 *      on the SUMMARY, a domain mismatch found on the header — leaves most of a large upload
 *      unread, and calling that "truncated" would relabel almost every genuine refusal.
 *   2. It fires only when a length was actually claimed, and claimed usably.
 *   3. It never touches a complete upload's refusal, which is where §12 still rules.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §7.3, §12.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/shared/lib/auth/session";
import type { RestoreInput, RestoreOutcome } from "@backup/account/application/import";

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock("@/shared/lib/security", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/security")>()),
  validateCsrf: vi.fn(async () => true),
}));
vi.mock("@/shared/lib/security/step-code-gate", () => ({ checkStepCode: vi.fn() }));
vi.mock("@/shared/lib/settings/admin-settings", () => ({
  getAdminSettings: vi.fn(async () => ({})),
  isUploadAllowed: vi.fn(() => ({ allowed: true })),
}));
vi.mock("@backup/account/application/import", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@backup/account/application/import")>()),
  restoreAccountArchive: vi.fn(),
}));
vi.mock("@backup/account/domain/keys", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@backup/account/domain/keys")>()),
  parseMasterKeyRing: vi.fn(() => ({ active: null, keys: [] })),
}));
vi.mock("@backup/account/infrastructure/account-keys", () => ({
  adoptIdentity: vi.fn(async () => undefined),
  listBoundIdentities: vi.fn(async () => []),
}));
vi.mock("@backup/account/infrastructure/ledger", () => ({
  drizzleRestoreLedger: vi.fn(() => ({})),
}));
vi.mock("@backup/account/infrastructure/sessions", () => ({
  filesRestoreSession: vi.fn(() => ({ swap: null })),
  brainRestoreSession: vi.fn(() => ({ deleted: null })),
}));
vi.mock("../app/api/backup/_guard", () => ({
  requireBackupRequester: vi.fn(async () => ({
    user: {
      id: "11111111-1111-4111-8111-111111111111",
      role: "user",
      email: "member@example.test",
      effectiveUserId: "11111111-1111-4111-8111-111111111111",
      isImpersonating: false,
      sessionId: "session-a",
    } as SessionUser,
    requester: { id: "11111111-1111-4111-8111-111111111111", role: "user" },
  })),
}));

const { logActivity } = await import("@/shared/lib/auth/audit");
const { restoreAccountArchive } = await import("@backup/account/application/import");
const { AfrDomainMismatchError, AfrUnreadableError } = await import(
  "@backup/account/domain/errors"
);
const { POST } = await import("../app/api/backup/restore/route");

/** The whole upload in these tests. Small on purpose: the predicate counts, it does not read. */
const SENT_BYTES = 64;

/**
 * One POST, with a body of {@link SENT_BYTES} and whatever length it cares to claim.
 *
 * A real `NextRequest`, because `content-length` is the header under test and a hand-rolled stub
 * could not prove undici keeps it. `duplex` is required for a streamed body and is absent from
 * every `RequestInit` in the lib types, hence the intersection.
 */
type StreamedInit = NonNullable<ConstructorParameters<typeof NextRequest>[1]> & {
  duplex: "half";
};

function restoreRequest(contentLength: string | null): NextRequest {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(SENT_BYTES));
      controller.close();
    },
  });
  const headers = new Headers({ "x-afr-domain": "files", "x-afr-mode": "merge" });
  if (contentLength !== null) headers.set("content-length", contentLength);
  const init: StreamedInit = { method: "POST", headers, body, duplex: "half" };
  return new NextRequest("http://localhost/api/backup/restore", init);
}

/** Read the upload to its end, then fail the way a missing trailer fails. */
function drainThenFail(error: Error) {
  return async (input: RestoreInput): Promise<never> => {
    for await (const chunk of input.source as AsyncIterable<Uint8Array>) {
      void chunk.byteLength;
    }
    throw error;
  };
}

/** Refuse on the first chunk, the way a header or SUMMARY refusal does, leaving the rest unread. */
function refuseEarly(error: Error) {
  return async (input: RestoreInput): Promise<never> => {
    const iterator = (input.source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    throw error;
  };
}

/** The bare minimum `successBody` reads, for the one test that must not fail. */
function outcome(): RestoreOutcome {
  return {
    restoreBatchId: "batch-1",
    report: { domain: "files", mode: "merge", rows: 1, bytes: SENT_BYTES, skipped: 0, renamed: 0 },
    backupId: "backup-1",
    createdAt: 0,
    formatVersion: 1,
    keyId: "key-1",
    via: "master",
    stale: false,
    adopted: false,
    summary: { accountBackupId: "acct-1", counts: { rows: 1 }, totalBytes: SENT_BYTES },
  } as unknown as RestoreOutcome;
}

/** The metadata of the `backup_restore_refused` line, which is where the detail is allowed to be. */
function refusalMetadata(): Record<string, unknown> {
  const call = vi
    .mocked(logActivity)
    .mock.calls.find((args) => args[1] === "backup_restore_refused");
  expect(call, "no refusal was audited").toBeDefined();
  return (call![2] as { metadata: Record<string, unknown> }).metadata;
}

beforeEach(() => {
  vi.mocked(logActivity).mockClear();
  vi.mocked(restoreAccountArchive).mockReset();
});

describe("an upload that ended early is reported as an upload that ended early", () => {
  it("replaces the reader's refusal when the body fell short of its own length", async () => {
    vi.mocked(restoreAccountArchive).mockImplementation(
      drainThenFail(new AfrUnreadableError(6, "trailer hmac mismatch"))
    );

    const res = await POST(restoreRequest("4096"));
    const json = (await res.json()) as { error: string; code: string };

    expect(res.status).toBe(400);
    expect(json.code).toBe("AFRBAK_UPLOAD_TRUNCATED");
    // The sentence the user was wrongly shown, and must not be shown for this.
    expect(json.error).not.toMatch(/recovery phrase/i);
    expect(json.error).toMatch(/upload stopped/i);
  });

  it("keeps both codes and both counts in the audit line", async () => {
    vi.mocked(restoreAccountArchive).mockImplementation(
      drainThenFail(new AfrUnreadableError(6, "trailer hmac mismatch"))
    );

    await POST(restoreRequest("4096"));

    // `detail` is still the reader's own words: the response was rewritten, the record was not.
    expect(refusalMetadata()).toMatchObject({
      code: "AFRBAK_UPLOAD_TRUNCATED",
      replacedCode: "AFRBAK_UNREADABLE",
      reason: 6,
      receivedBytes: SENT_BYTES,
      expectedBytes: 4096,
      detail: "refusal 6: trailer hmac mismatch",
      result: "refused",
    });
  });
});

describe("everything else keeps the refusal it earned", () => {
  it("leaves a complete upload's unreadable archive vague, as §12 requires", async () => {
    vi.mocked(restoreAccountArchive).mockImplementation(
      drainThenFail(new AfrUnreadableError(3, "keyslot 1 did not open"))
    );

    const res = await POST(restoreRequest(String(SENT_BYTES)));
    const json = (await res.json()) as { error: string; code: string };

    expect(res.status).toBe(422);
    expect(json.code).toBe("AFRBAK_UNREADABLE");
    expect(json.error).toMatch(/recovery phrase/i);
    expect(refusalMetadata()).not.toHaveProperty("replacedCode");
  });

  it("does not call an early refusal a truncation, however much body is left unread", async () => {
    // The property that makes this safe at all: a domain mismatch is decided on the header, so
    // 4032 of the 4096 claimed bytes are still in flight. Without the EOF check every refusal on
    // a large archive would come back as "your upload was cut short".
    vi.mocked(restoreAccountArchive).mockImplementation(
      refuseEarly(new AfrDomainMismatchError("brain", "files"))
    );

    const res = await POST(restoreRequest("4096"));
    const json = (await res.json()) as { code: string };

    expect(res.status).toBe(422);
    expect(json.code).toBe("AFRBAK_DOMAIN_MISMATCH");
  });

  it("stays quiet when the request claimed no length, or an unusable one", async () => {
    // No claim is not evidence of a short body: `chunked`, a proxy that dropped the header, a
    // client that never set one. Nor is a length that is not a positive whole number.
    for (const header of [null, "banana", "0", "-1", "4096, 4096", "9007199254740993"]) {
      vi.mocked(logActivity).mockClear();
      vi.mocked(restoreAccountArchive).mockImplementation(
        drainThenFail(new AfrUnreadableError(6, "trailer hmac mismatch"))
      );

      const res = await POST(restoreRequest(header));
      const json = (await res.json()) as { code: string };

      expect(res.status, `content-length: ${header}`).toBe(422);
      expect(json.code, `content-length: ${header}`).toBe("AFRBAK_UNREADABLE");
    }
  });
});

describe("counting the bytes changes nothing about them", () => {
  it("hands the reader every byte, and lets a success be a success", async () => {
    let received = 0;
    vi.mocked(restoreAccountArchive).mockImplementation(async (input: RestoreInput) => {
      for await (const chunk of input.source as AsyncIterable<Uint8Array>) {
        received += chunk.byteLength;
      }
      return outcome();
    });

    const res = await POST(restoreRequest(String(SENT_BYTES)));

    expect(res.status).toBe(200);
    expect(received).toBe(SENT_BYTES);
  });
});

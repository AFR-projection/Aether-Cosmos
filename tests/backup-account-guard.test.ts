/**
 * `requireBackupRequester`: acceptance test #29, from both ends.
 *
 * The behavioural half proves the guard refuses an impersonating session and hands the feature
 * two fields. The structural half proves all five per-account endpoints (§10) actually go
 * through it — a guard nobody calls is not a guard, and that is a mistake a sixth route added
 * next month makes silently. So the route list is written out here and each entry is checked
 * against the file on disk.
 *
 * Why impersonation is refused rather than merely audited: a master wearing another user's face
 * keeps `role: "master"` and their own `id`, so nothing downstream would have *broken* — but an
 * archive is too large a thing to leave that ambiguity around, and a takeout attributed to a
 * master through a session that says otherwise is a log entry nobody can interpret later.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §10, §16 test #29.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { BackupError } from "@backup/domain/errors";
import type { SessionUser } from "@/shared/lib/auth/session";

const store = vi.hoisted(() => ({ user: null as unknown }));

vi.mock("@/shared/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/session")>();
  return {
    ...actual,
    requireAuth: vi.fn(async () => {
      if (store.user === null) throw new actual.AuthError("Unauthorized", 401);
      return store.user as SessionUser;
    }),
  };
});

const { requireBackupRequester } = await import("../app/api/backup/_guard");
const { requireAuth, AuthError } = await import("@/shared/lib/auth/session");

const ROOT = join(__dirname, "..");

/**
 * Source with its comments removed.
 *
 * Every check below is about the order statements run in, and `restore/route.ts` names
 * `request.body` in its header comment 150 lines above the handler that reads it. Comparing
 * raw offsets would make that comment a failure.
 */
function sourceOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Only the fields the guard reads; the rest of `SessionUser` is irrelevant to it. */
function session(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    role: "user",
    email: "member@example.test",
    effectiveUserId: "11111111-1111-4111-8111-111111111111",
    isImpersonating: false,
    sessionId: "session-a",
    ...over,
  } as SessionUser;
}

beforeEach(() => {
  store.user = session();
  vi.mocked(requireAuth).mockClear();
});

describe("the actor is the real signed-in account", () => {
  it("passes a plain member through with two fields and no more", async () => {
    const { user, requester } = await requireBackupRequester();

    expect(requester).toEqual({ id: user.id, role: "user" });
    // Exactly two keys: the backup layer must never see a `userId` it could be talked into
    // trusting, and the only way to guarantee that is for one not to be there.
    expect(Object.keys(requester).sort()).toEqual(["id", "role"]);
  });

  it("passes the master through the same door", async () => {
    store.user = session({ role: "master" });

    expect((await requireBackupRequester()).requester.role).toBe("master");
  });

  it("refuses an impersonating session, whichever role it wears", async () => {
    // Both roles the app has: the refusal is about the session, not about privilege. A master
    // wearing a member's face is refused for the same reason a member's own session would be.
    const roles: SessionUser["role"][] = ["master", "user"];

    for (const role of roles) {
      store.user = session({ role, isImpersonating: true });

      const error = await requireBackupRequester().then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(BackupError);
      expect((error as BackupError).status).toBe(403);
      expect((error as BackupError).code).toBe("BACKUP_FORBIDDEN");
      expect((error as BackupError).message).toMatch(/while impersonating/);
    }
  });

  it("takes the impersonator's own id, never the face they are wearing", async () => {
    // Belt and braces: the refusal above is what actually protects this, but if the refusal
    // were ever relaxed to an audit note, `effectiveUserId` must still not become the owner.
    store.user = session({
      isImpersonating: false,
      effectiveUserId: "22222222-2222-4222-8222-222222222222",
    });

    const { requester } = await requireBackupRequester();

    expect(requester.id).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("lets an unauthenticated caller's 401 through untouched", async () => {
    store.user = null;

    // `requireAuth` throws `AuthError`, which the route handlers already map to 401 with the
    // session's own codes. Wrapping it here would lose `SESSION_IP_CHANGED` and its redirect.
    const error = await requireBackupRequester().then(
      () => null,
      (caught: unknown) => caught
    );

    expect(error).not.toBeInstanceOf(BackupError);
    expect(error).toBeInstanceOf(AuthError);
    expect((error as InstanceType<typeof AuthError>).status).toBe(401);
  });

  it("authorizes before it decides anything, on every call", async () => {
    await requireBackupRequester();
    store.user = session({ isImpersonating: true });
    await requireBackupRequester().catch(() => null);

    expect(vi.mocked(requireAuth)).toHaveBeenCalledTimes(2);
  });
});

/* ── the five endpoints of §10 ────────────────────────────────────────────── */

/** Every per-account route, and what it does. Written out so a sixth one has to be added. */
const ACCOUNT_ROUTES: Array<{ path: string; method: "GET" | "POST"; csrf: boolean }> = [
  { path: "app/api/backup/identity/route.ts", method: "GET", csrf: false },
  { path: "app/api/backup/takeout/prepare/route.ts", method: "POST", csrf: true },
  { path: "app/api/backup/takeout/[ticket]/route.ts", method: "GET", csrf: false },
  { path: "app/api/backup/restore/inspect/route.ts", method: "POST", csrf: true },
  { path: "app/api/backup/restore/route.ts", method: "POST", csrf: true },
];

describe("all five endpoints go through the one guard", () => {
  it("calls requireBackupRequester and never requireAuth directly", () => {
    for (const { path } of ACCOUNT_ROUTES) {
      const source = sourceOf(path);

      expect(source, path).toContain("requireBackupRequester()");
      // A route that called `requireAuth()` itself would be authenticated and unguarded — the
      // exact shape of the bug this test exists to prevent.
      expect(source.includes("await requireAuth()"), `${path} bypasses the guard`).toBe(false);
    }
  });

  it("guards before it reads anything the caller sent", () => {
    for (const { path } of ACCOUNT_ROUTES) {
      const source = sourceOf(path);
      const guardAt = source.indexOf("requireBackupRequester()");

      for (const read of ["request.json()", "request.body", "await params"]) {
        const readAt = source.indexOf(read);
        if (readAt >= 0) {
          expect(guardAt, `${path}: guard must precede ${read}`).toBeLessThan(readAt);
        }
      }
    }
  });

  it("puts CSRF ahead of the guard on the three mutating routes", () => {
    for (const { path, csrf } of ACCOUNT_ROUTES) {
      const source = sourceOf(path);
      if (!csrf) {
        // A navigation cannot carry a token, and a GET mutates nothing — but it still runs the
        // full guard, which is the line above this one.
        expect(source.includes("validateCsrf"), `${path} needs no CSRF`).toBe(false);
        continue;
      }
      expect(source, path).toContain("validateCsrf");
      expect(source.indexOf("validateCsrf"), path).toBeLessThan(
        source.indexOf("requireBackupRequester()")
      );
    }
  });

  it("exports the method it claims and no other", () => {
    for (const { path, method } of ACCOUNT_ROUTES) {
      const source = sourceOf(path);
      const other = method === "GET" ? "POST" : "GET";

      expect(source, path).toMatch(new RegExp(`export async function ${method}\\s*\\(`));
      expect(source, path).not.toMatch(new RegExp(`export async function ${other}\\s*\\(`));
      for (const mutation of ["PUT", "PATCH", "DELETE"]) {
        expect(source, `${path} ${mutation}`).not.toMatch(
          new RegExp(`export async function ${mutation}\\s*\\(`)
        );
      }
    }
  });

  it("keeps the guard itself the only place impersonation is decided", () => {
    const guard = sourceOf("app/api/backup/_guard.ts");

    expect(guard).toContain("user.isImpersonating");
    for (const { path } of ACCOUNT_ROUTES) {
      // Five copies of one condition is five chances to write the wrong one.
      expect(sourceOf(path).includes("isImpersonating"), `${path} re-checks it`).toBe(false);
    }
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { File, Folder } from "@/shared/infrastructure/db/schema";
import type { FileAccess, FolderAccess } from "@/shared/lib/auth/permissions";

/**
 * Route-level authorization gates for shared files.
 *
 * A `view` member deleted a shared folder and it disappeared from the OWNER's account. The
 * capability model that prevents it lives in `src/shared/lib/auth/permissions.ts` (unit-tested in
 * `folder-permissions.test.ts`); what is pinned HERE is that every mutating route actually
 * consults it and stops BEFORE touching the database — a gate that returns 403 after the
 * UPDATE has run is not a gate.
 *
 * Every DB / storage / cache dependency is mocked, so a passing test means "the route
 * refused and wrote nothing", not "the query happened to fail".
 */

const dbCalls = vi.hoisted(() => ({ updates: 0, inserts: 0, deletes: 0 }));

vi.mock("@/shared/infrastructure/db", () => {
  type Q = {
    set: (...a: unknown[]) => Q;
    where: (...a: unknown[]) => Q;
    values: (...a: unknown[]) => Q;
    from: (...a: unknown[]) => Q;
    innerJoin: (...a: unknown[]) => Q;
    orderBy: (...a: unknown[]) => Q;
    returning: (...a: unknown[]) => Promise<unknown[]>;
    limit: (...a: unknown[]) => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) => Promise<unknown>;
  };

  function q(result: unknown[] = []): Q {
    const api: Q = {
      set: () => api,
      where: () => api,
      values: () => api,
      from: () => api,
      innerJoin: () => api,
      orderBy: () => api,
      returning: async () => result,
      limit: async () => result,
      then: (r, j) => Promise.resolve(result).then(r, j),
    };
    return api;
  }

  return {
    db: {
      select: () => q(),
      update: () => {
        dbCalls.updates++;
        return q();
      },
      insert: () => {
        dbCalls.inserts++;
        return q([{ id: "new" }]);
      },
      delete: () => {
        dbCalls.deletes++;
        return q([{ id: "gone" }]);
      },
    },
    recalculateUsedBytes: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/security")>();
  return {
    ...actual,
    validateCsrf: vi.fn(),
    checkUserApiRateLimit: vi.fn(),
  };
});

vi.mock("@/shared/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/session")>();
  return { ...actual, requireAuth: vi.fn(), getClientIp: vi.fn(() => "127.0.0.1") };
});

vi.mock("@/shared/lib/auth/api-key", () => ({
  requireAuthOrApiKey: vi.fn(),
  requireMasterOrApiKey: vi.fn(),
}));

// The refusal wording stays real — the routes must return the user-facing reason, not a
// generic "Forbidden" that reads like a bug.
vi.mock("@/shared/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/permissions")>();
  return {
    ...actual,
    resolveFileAccess: vi.fn(),
    resolveFolderAccess: vi.fn(),
    resolveWritableDestination: vi.fn(),
    fileDomainOwnerId: vi.fn(async () => OWNER),
  };
});

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/shared/infrastructure/cache/redis", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelPattern: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@files/infrastructure/storage/r2", () => ({
  buildR2Key: vi.fn(() => "k"),
  copyR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Objects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/infrastructure/webhooks/dispatch", () => ({
  dispatchWebhookEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/lib/settings/admin-settings", () => ({
  getAdminSettings: vi.fn().mockResolvedValue({ rateLimitPerMinute: 1000 }),
}));
vi.mock("@/shared/lib/search/tiptap-text", () => ({ tiptapToPlainText: vi.fn(() => "") }));

// Zod 4 validates the RFC 9562 version + variant nibbles, so these have to be *real* v4
// UUIDs ("...-4xxx-8xxx-...") or the routes 400 on parsing and never reach the gate.
const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const FILE_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID_2 = "55555555-5555-4555-8555-555555555555";
const FOLDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const { validateCsrf, checkUserApiRateLimit } = await import("@/shared/lib/security");
const { requireAuth } = await import("@/shared/lib/auth/session");
const { requireAuthOrApiKey } = await import("@/shared/lib/auth/api-key");
const { resolveFileAccess, resolveFolderAccess, resolveWritableDestination } = await import(
  "@/shared/lib/auth/permissions"
);
const { deleteR2Objects, deleteR2Object } = await import("@files/infrastructure/storage/r2");
const filesRoute = await import("@/app/api/files/route");
const batchRoute = await import("@/app/api/files/batch/route");

/** A shared file the caller can see but (by default) not change. */
function fileRow(over: Partial<File> = {}): File {
  return {
    id: FILE_ID,
    userId: OWNER,
    folderId: FOLDER_ID,
    name: "budget.xlsx",
    mimeType: "application/vnd.ms-excel",
    sizeBytes: 10,
    r2Key: "u/owner/budget.xlsx",
    thumbnailKey: null,
    isFavorite: false,
    isNote: false,
    deletedAt: null,
    status: "ready",
    ...over,
  } as unknown as File;
}

/** Capabilities of a `view` member, which is "see it, touch nothing". */
function viewAccess(over: Partial<FileAccess> = {}): FileAccess {
  return {
    file: fileRow(),
    role: "view",
    isOwner: false,
    canView: true,
    canEdit: false,
    canTrash: false,
    canPurge: false,
    canOwnerOnlyFlags: false,
    masterOverride: false,
    folderAccess: null,
    ...over,
  } as FileAccess;
}

/** Capabilities of an `edit` member: contents yes, irreversible things no. */
function editAccess(over: Partial<FileAccess> = {}): FileAccess {
  return viewAccess({ role: "edit", canEdit: true, canTrash: true, ...over });
}

function folderAccess(over: Partial<FolderAccess> = {}): FolderAccess {
  return {
    folder: { id: FOLDER_ID, userId: OWNER, name: "Work" } as unknown as Folder,
    role: "view",
    isOwner: false,
    viaMembership: true,
    masterOverride: false,
    shareRootId: FOLDER_ID,
    isShareRoot: true,
    canView: true,
    canEdit: false,
    canManageMembers: false,
    canTrashFolder: false,
    canPurge: false,
    canOwnerOnlyFlags: false,
    ...over,
  } as FolderAccess;
}

function req(method: string, body: unknown, path = "/api/files"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  dbCalls.updates = 0;
  dbCalls.inserts = 0;
  dbCalls.deletes = 0;
  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(checkUserApiRateLimit).mockReset().mockResolvedValue({ allowed: true } as never);
  const session = { id: MEMBER, effectiveUserId: MEMBER, role: "user", isImpersonating: false, sessionId: "s" };
  vi.mocked(requireAuth).mockReset().mockResolvedValue(session as never);
  vi.mocked(requireAuthOrApiKey).mockReset().mockResolvedValue(session as never);
  vi.mocked(resolveFileAccess).mockReset().mockResolvedValue(viewAccess());
  vi.mocked(resolveFolderAccess).mockReset().mockResolvedValue(folderAccess());
  vi.mocked(resolveWritableDestination)
    .mockReset()
    .mockResolvedValue({ ok: true, folderId: FOLDER_ID });
  vi.mocked(deleteR2Objects).mockClear();
  vi.mocked(deleteR2Object).mockClear();
});

describe("PATCH /api/files — single-file gates", () => {
  it("refuses a rename from a `view` member and writes nothing", async () => {
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "rename", name: "x" }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/view access/i);
    expect(dbCalls.updates).toBe(0);
  });

  it("refuses a move from a `view` member", async () => {
    const res = await filesRoute.PATCH(
      req("PATCH", { id: FILE_ID, action: "move", folderId: FOLDER_ID })
    );
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
    // The destination is never even consulted — the caller may not edit at all.
    expect(resolveWritableDestination).not.toHaveBeenCalled();
  });

  it("keeps the favourite flag with the owner even for an `edit` member", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "favorite" }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/favorite/i);
    expect(dbCalls.updates).toBe(0);
  });

  it("keeps restore-from-bin with the owner even for an `edit` member", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(
      editAccess({ file: fileRow({ deletedAt: new Date() }) })
    );
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "restore" }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("refuses a trash from a `view` member", async () => {
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "delete" }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("propagates a destination refusal from the sharing-domain rule", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    vi.mocked(resolveWritableDestination).mockResolvedValue({
      ok: false,
      status: 400,
      message: "A file can't be moved out of the folder it was shared in.",
    });
    const res = await filesRoute.PATCH(
      req("PATCH", { id: FILE_ID, action: "move", folderId: FOLDER_ID })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/out of the folder it was shared in/i);
    expect(dbCalls.updates).toBe(0);
  });

  it("still lets an `edit` member rename — the gate is not a blanket block", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "rename", name: "new.xlsx" }));
    expect(res.status).toBe(200);
    expect(dbCalls.updates).toBe(1);
  });

  it("404s a file the caller cannot see at all", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(null);
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "rename", name: "x" }));
    expect(res.status).toBe(404);
    expect(dbCalls.updates).toBe(0);
  });

  it("checks CSRF before anything else", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await filesRoute.PATCH(req("PATCH", { id: FILE_ID, action: "rename", name: "x" }));
    expect(res.status).toBe(403);
    expect(resolveFileAccess).not.toHaveBeenCalled();
    expect(dbCalls.updates).toBe(0);
  });
});

describe("DELETE /api/files — trash vs purge", () => {
  it("refuses a permanent delete from an `edit` member and deletes no object", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(
      editAccess({ file: fileRow({ deletedAt: new Date() }) })
    );
    const res = await filesRoute.DELETE(req("DELETE", { id: FILE_ID, permanent: true }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/permanen/i);
    expect(dbCalls.deletes).toBe(0);
    expect(deleteR2Object).not.toHaveBeenCalled();
  });

  it("refuses a trash from a `view` member", async () => {
    const res = await filesRoute.DELETE(req("DELETE", { id: FILE_ID, permanent: false }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });
});

describe("POST /api/files — creating a note inside a shared folder", () => {
  it("refuses a `view` member and inserts nothing", async () => {
    const res = await filesRoute.POST(
      req("POST", { name: "Notes", folderId: FOLDER_ID })
    );
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/view access/i);
    expect(dbCalls.inserts).toBe(0);
  });

  it("lets an `edit` member create one", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(
      folderAccess({ role: "edit", canEdit: true })
    );
    const res = await filesRoute.POST(req("POST", { name: "Notes", folderId: FOLDER_ID }));
    expect(res.status).toBe(200);
    expect(dbCalls.inserts).toBeGreaterThan(0);
  });
});

describe("PATCH /api/files/batch — all-or-nothing", () => {
  it("refuses the WHOLE batch when one file is off limits", async () => {
    // First file is fine, second is only viewable: a partially applied destructive batch is
    // worse than a rejected one.
    vi.mocked(resolveFileAccess)
      .mockResolvedValueOnce(editAccess())
      .mockResolvedValueOnce(viewAccess({ file: fileRow({ id: FILE_ID_2 }) }));
    const res = await batchRoute.PATCH(
      req("PATCH", { ids: [FILE_ID, FILE_ID_2], action: "delete" }, "/api/files/batch")
    );
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("keeps a batch favourite with the owner", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    const res = await batchRoute.PATCH(
      req("PATCH", { ids: [FILE_ID], action: "favorite" }, "/api/files/batch")
    );
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("keeps a batch restore with the owner", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    const res = await batchRoute.PATCH(
      req("PATCH", { ids: [FILE_ID], action: "restore" }, "/api/files/batch")
    );
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("validates the destination of a batch move before moving anything", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(editAccess());
    vi.mocked(resolveWritableDestination).mockResolvedValue({
      ok: false,
      status: 400,
      message: "A file can't be moved out of the folder it was shared in.",
    });
    const res = await batchRoute.PATCH(
      req("PATCH", { ids: [FILE_ID, FILE_ID_2], action: "move", folderId: FOLDER_ID }, "/api/files/batch")
    );
    expect(res.status).toBe(400);
    expect(dbCalls.updates).toBe(0);
  });

  it("checks CSRF first", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await batchRoute.PATCH(
      req("PATCH", { ids: [FILE_ID], action: "delete" }, "/api/files/batch")
    );
    expect(res.status).toBe(403);
    expect(resolveFileAccess).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/files/batch — permanent purge", () => {
  it("refuses an `edit` member and touches neither storage nor the table", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(
      editAccess({ file: fileRow({ deletedAt: new Date() }) })
    );
    const res = await batchRoute.DELETE(
      req("DELETE", { ids: [FILE_ID], permanent: true }, "/api/files/batch")
    );
    expect(res.status).toBe(403);
    expect(deleteR2Objects).not.toHaveBeenCalled();
    expect(dbCalls.deletes).toBe(0);
  });

  it("refuses to purge files that never reached the recycle bin", async () => {
    // canPurge is granted, but the rows are live — purging must still go through the bin.
    vi.mocked(resolveFileAccess).mockResolvedValue(
      editAccess({ canPurge: true, file: fileRow({ deletedAt: null }) })
    );
    const res = await batchRoute.DELETE(
      req("DELETE", { ids: [FILE_ID], permanent: true }, "/api/files/batch")
    );
    expect(res.status).toBe(404);
    expect(deleteR2Objects).not.toHaveBeenCalled();
    expect(dbCalls.deletes).toBe(0);
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Folder } from "@/lib/db/schema";
import type { FolderAccess } from "@/lib/auth/permissions";

/**
 * Route-level authorization gates for shared FOLDERS — the routes the reported incident
 * actually went through.
 *
 * A member invited as `view` deleted a shared folder and it vanished from the OWNER's
 * account. `folder-permissions.test.ts` pins the capability model; this pins that
 * `PATCH/DELETE /api/folders`, the members route and the invitation route all consult it
 * and refuse BEFORE any write. Every DB / storage call is counted, so "403 and wrote
 * nothing" is asserted, not assumed.
 */

const dbCalls = vi.hoisted(() => ({ updates: 0, inserts: 0, deletes: 0, executes: 0 }));
/** FIFO of results for successive `db.select()` chains; empty queue answers `[]`. */
const selectQueue = vi.hoisted(() => ({ rows: [] as unknown[][] }));

vi.mock("@/lib/db", () => {
  type Q = {
    set: (...a: unknown[]) => Q;
    where: (...a: unknown[]) => Q;
    values: (...a: unknown[]) => Q;
    from: (...a: unknown[]) => Q;
    innerJoin: (...a: unknown[]) => Q;
    orderBy: (...a: unknown[]) => Q;
    onConflictDoUpdate: (...a: unknown[]) => Q;
    returning: (...a: unknown[]) => Promise<unknown[]>;
    limit: (...a: unknown[]) => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) => Promise<unknown>;
  };

  function q(result: () => unknown[]): Q {
    const api: Q = {
      set: () => api,
      where: () => api,
      values: () => api,
      from: () => api,
      innerJoin: () => api,
      orderBy: () => api,
      onConflictDoUpdate: () => api,
      returning: async () => result(),
      limit: async () => result(),
      then: (r, j) => Promise.resolve(result()).then(r, j),
    };
    return api;
  }

  return {
    db: {
      select: () => q(() => selectQueue.rows.shift() ?? []),
      update: () => {
        dbCalls.updates++;
        return q(() => [{ id: "updated", userId: "updated" }]);
      },
      insert: () => {
        dbCalls.inserts++;
        return q(() => [{ id: "new" }]);
      },
      delete: () => {
        dbCalls.deletes++;
        return q(() => [{ id: "gone" }]);
      },
      execute: async () => {
        dbCalls.executes++;
        return [];
      },
    },
    recalculateUsedBytes: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn(), checkUserApiRateLimit: vi.fn() };
});

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return { ...actual, requireAuth: vi.fn(), getClientIp: vi.fn(() => "127.0.0.1") };
});

vi.mock("@/lib/auth/api-key", () => ({
  requireAuthOrApiKey: vi.fn(),
  requireMasterOrApiKey: vi.fn(),
}));

// `shareRefusal` stays real: the wording is what tells a member why the button did nothing.
vi.mock("@/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/permissions")>();
  return {
    ...actual,
    resolveFolderAccess: vi.fn(),
    listAccessibleFolders: vi.fn(async () => []),
  };
});

vi.mock("@/lib/auth/audit", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/cache/redis", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDelPattern: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/r2", () => ({
  deleteR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Objects: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/storage/deletion-service", () => ({
  createFolderDeletionJob: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/admin-settings", () => ({
  getAdminSettings: vi.fn().mockResolvedValue({ rateLimitPerMinute: 1000 }),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const FOLDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUBFOLDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OUTSIDE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const INVITATION_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const { validateCsrf, checkUserApiRateLimit } = await import("@/lib/security");
const { requireAuth } = await import("@/lib/auth/session");
const { requireAuthOrApiKey } = await import("@/lib/auth/api-key");
const { resolveFolderAccess } = await import("@/lib/auth/permissions");
const { deleteR2Objects } = await import("@/lib/storage/r2");
const foldersRoute = await import("@/app/api/folders/route");
const membersRoute = await import("@/app/api/folders/[id]/members/route");
const invitationsRoute = await import("@/app/api/invitations/route");

function folderRow(over: Partial<Folder> = {}): Folder {
  return {
    id: FOLDER_ID,
    userId: OWNER,
    parentId: null,
    name: "Work",
    materializedPath: "/Work/",
    depth: 0,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as Folder;
}

/** A `view` member at the share root: may look, may do nothing. */
function viewAccess(over: Partial<FolderAccess> = {}): FolderAccess {
  return {
    folder: folderRow(),
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

/** An `edit` member: contents yes, the share root itself and purging no. */
function editAccess(over: Partial<FolderAccess> = {}): FolderAccess {
  return viewAccess({ role: "edit", canEdit: true, ...over });
}

/** A nested subfolder of the share — `edit` may rename/move/trash this one. */
function editSubAccess(over: Partial<FolderAccess> = {}): FolderAccess {
  return editAccess({
    folder: folderRow({ id: SUBFOLDER_ID, name: "Sub", materializedPath: "/Work/Sub/", depth: 1, parentId: FOLDER_ID }),
    isShareRoot: false,
    canTrashFolder: true,
    ...over,
  });
}

function ownerAccess(over: Partial<FolderAccess> = {}): FolderAccess {
  return {
    folder: folderRow(),
    role: "owner",
    isOwner: true,
    viaMembership: false,
    masterOverride: false,
    shareRootId: null,
    isShareRoot: false,
    canView: true,
    canEdit: true,
    canManageMembers: true,
    canTrashFolder: true,
    canPurge: true,
    canOwnerOnlyFlags: true,
    ...over,
  } as FolderAccess;
}

function req(method: string, body: unknown, path = "/api/folders"): NextRequest {
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The dynamic segment the members route awaits. */
function ctx(id = FOLDER_ID) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  dbCalls.updates = 0;
  dbCalls.inserts = 0;
  dbCalls.deletes = 0;
  dbCalls.executes = 0;
  selectQueue.rows = [];
  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(checkUserApiRateLimit).mockReset().mockResolvedValue({ allowed: true } as never);
  const session = { id: MEMBER, effectiveUserId: MEMBER, role: "user", isImpersonating: false, sessionId: "s" };
  vi.mocked(requireAuth).mockReset().mockResolvedValue(session as never);
  vi.mocked(requireAuthOrApiKey).mockReset().mockResolvedValue(session as never);
  vi.mocked(resolveFolderAccess).mockReset().mockResolvedValue(viewAccess());
  vi.mocked(deleteR2Objects).mockClear();
});

describe("DELETE /api/folders — the reported incident", () => {
  it("a `view` member cannot trash a shared folder, and nothing is written", async () => {
    // This is the exact call that removed the folder from the owner's account.
    selectQueue.rows = [[folderRow()]];
    const res = await foldersRoute.DELETE(req("DELETE", { id: FOLDER_ID, permanent: false }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/view access/i);
    expect(dbCalls.executes).toBe(0);
    expect(dbCalls.deletes).toBe(0);
    expect(deleteR2Objects).not.toHaveBeenCalled();
  });

  it("an `edit` member cannot trash the folder that was shared with them", async () => {
    // Trashing the share root would still take it out of the owner's account. Leaving the
    // share is the member's action; deleting is not.
    selectQueue.rows = [[folderRow()]];
    vi.mocked(resolveFolderAccess).mockResolvedValue(editAccess());
    const res = await foldersRoute.DELETE(req("DELETE", { id: FOLDER_ID, permanent: false }));
    expect(res.status).toBe(403);
    expect(dbCalls.executes).toBe(0);
  });

  it("an `edit` member cannot purge, even a subfolder they may trash", async () => {
    selectQueue.rows = [[folderRow({ id: SUBFOLDER_ID, materializedPath: "/Work/Sub/" })]];
    vi.mocked(resolveFolderAccess).mockResolvedValue(editSubAccess());
    const res = await foldersRoute.DELETE(req("DELETE", { id: SUBFOLDER_ID, permanent: true }));
    expect(res.status).toBe(403);
    expect(dbCalls.executes).toBe(0);
    expect(deleteR2Objects).not.toHaveBeenCalled();
  });

  it("still lets the OWNER delete their own folder — the gate is not a blanket block", async () => {
    // folder row, then the (empty) subtree-file listing.
    selectQueue.rows = [[folderRow()], []];
    vi.mocked(resolveFolderAccess).mockResolvedValue(ownerAccess());
    const res = await foldersRoute.DELETE(req("DELETE", { id: FOLDER_ID, permanent: false }));
    expect(res.status).toBe(200);
    expect(dbCalls.executes).toBeGreaterThan(0);
  });

  it("checks CSRF before resolving access at all", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await foldersRoute.DELETE(req("DELETE", { id: FOLDER_ID, permanent: true }));
    expect(res.status).toBe(403);
    expect(resolveFolderAccess).not.toHaveBeenCalled();
    expect(dbCalls.executes).toBe(0);
  });
});

describe("PATCH /api/folders — rename / move / trash / restore", () => {
  it("refuses a rename from a `view` member", async () => {
    const res = await foldersRoute.PATCH(req("PATCH", { id: FOLDER_ID, action: "rename", name: "Mine" }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
    expect(dbCalls.executes).toBe(0);
  });

  it("refuses an `edit` member renaming the share root", async () => {
    // Renaming it would rename it in the owner's account too — surprising and unasked for.
    vi.mocked(resolveFolderAccess).mockResolvedValue(editAccess());
    const res = await foldersRoute.PATCH(req("PATCH", { id: FOLDER_ID, action: "rename", name: "Mine" }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("lets an `edit` member rename a subfolder inside the share", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(editSubAccess());
    const res = await foldersRoute.PATCH(req("PATCH", { id: SUBFOLDER_ID, action: "rename", name: "Renamed" }));
    expect(res.status).toBe(200);
    expect(dbCalls.updates).toBe(1);
  });

  it("refuses a trash from a `view` member", async () => {
    const res = await foldersRoute.PATCH(req("PATCH", { id: FOLDER_ID, action: "delete" }));
    expect(res.status).toBe(403);
    expect(dbCalls.executes).toBe(0);
  });

  it("keeps restore-from-bin with the owner", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(editSubAccess());
    const res = await foldersRoute.PATCH(req("PATCH", { id: SUBFOLDER_ID, action: "restore" }));
    expect(res.status).toBe(403);
    expect(dbCalls.executes).toBe(0);
  });

  it("refuses a member moving a subfolder out to their own tree root", async () => {
    // No parentId means "the caller's root", which is outside the share entirely.
    vi.mocked(resolveFolderAccess).mockResolvedValue(editSubAccess());
    const res = await foldersRoute.PATCH(req("PATCH", { id: SUBFOLDER_ID, action: "move" }));
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("refuses a move into a folder that belongs to a different account", async () => {
    vi.mocked(resolveFolderAccess)
      .mockResolvedValueOnce(editSubAccess())
      .mockResolvedValueOnce(
        ownerAccess({ folder: folderRow({ id: OUTSIDE_ID, userId: MEMBER, name: "Mine", materializedPath: "/Mine/" }) })
      );
    const res = await foldersRoute.PATCH(
      req("PATCH", { id: SUBFOLDER_ID, action: "move", parentId: OUTSIDE_ID })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/another owner's account/i);
    expect(dbCalls.updates).toBe(0);
  });

  it("refuses moving a folder into its own subtree", async () => {
    vi.mocked(resolveFolderAccess)
      .mockResolvedValueOnce(editAccess({ canEdit: true, isShareRoot: false, isOwner: true }))
      .mockResolvedValueOnce(
        ownerAccess({ folder: folderRow({ id: SUBFOLDER_ID, name: "Sub", materializedPath: "/Work/Sub/", depth: 1 }) })
      );
    const res = await foldersRoute.PATCH(
      req("PATCH", { id: FOLDER_ID, action: "move", parentId: SUBFOLDER_ID })
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.error).toMatch(/inside itself/i);
    expect(dbCalls.updates).toBe(0);
  });

  it("404s a folder the caller cannot see", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(null);
    const res = await foldersRoute.PATCH(req("PATCH", { id: FOLDER_ID, action: "delete" }));
    expect(res.status).toBe(404);
    expect(dbCalls.executes).toBe(0);
  });
});

describe("POST /api/folders — creating a subfolder in someone's share", () => {
  it("refuses a `view` member and inserts nothing", async () => {
    const res = await foldersRoute.POST(req("POST", { name: "New", parentId: FOLDER_ID }));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.error).toMatch(/view access/i);
    expect(dbCalls.inserts).toBe(0);
  });

  it("lets an `edit` member create one, owned by the folder's owner", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(editAccess());
    const res = await foldersRoute.POST(req("POST", { name: "New", parentId: FOLDER_ID }));
    expect(res.status).toBe(200);
    expect(dbCalls.inserts).toBe(1);
  });
});

describe("DELETE /api/folders/[id]/members — leaving vs removing", () => {
  it("lets a plain member leave the share without canManageMembers", async () => {
    // The member's counterpart to "delete this folder": only their own membership row goes.
    const res = await membersRoute.DELETE(
      req("DELETE", { userId: MEMBER }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.left).toBe(true);
    expect(dbCalls.deletes).toBeGreaterThan(0);
  });

  it("refuses a member removing somebody else", async () => {
    const res = await membersRoute.DELETE(
      req("DELETE", { userId: OTHER }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(dbCalls.deletes).toBe(0);
  });

  it("never removes the owner, even for a manager", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(ownerAccess());
    const res = await membersRoute.DELETE(
      req("DELETE", { userId: OWNER }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(400);
    expect(dbCalls.deletes).toBe(0);
  });

  it("checks CSRF first", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await membersRoute.DELETE(
      req("DELETE", { userId: MEMBER }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(resolveFolderAccess).not.toHaveBeenCalled();
    expect(dbCalls.deletes).toBe(0);
  });
});

describe("POST / PATCH /api/folders/[id]/members — who may invite", () => {
  it("refuses an invite from a member who does not manage the share", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(editAccess());
    const res = await membersRoute.POST(
      req("POST", { username: "someone", role: "edit" }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(dbCalls.inserts).toBe(0);
    expect(dbCalls.updates).toBe(0);
  });

  it("refuses a role change from a member who does not manage the share", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(editAccess());
    const res = await membersRoute.PATCH(
      req("PATCH", { userId: OTHER, role: "edit" }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(403);
    expect(dbCalls.updates).toBe(0);
  });

  it("lets the owner change a member's role and keeps the invitation row in step", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(ownerAccess());
    const res = await membersRoute.PATCH(
      req("PATCH", { userId: OTHER, role: "view" }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(200);
    // One UPDATE for the membership, one for the invitation history.
    expect(dbCalls.updates).toBe(2);
  });

  it("refuses to change the owner's own role", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(ownerAccess());
    const res = await membersRoute.PATCH(
      req("PATCH", { userId: OWNER, role: "view" }, `/api/folders/${FOLDER_ID}/members`),
      ctx()
    );
    expect(res.status).toBe(400);
    expect(dbCalls.updates).toBe(0);
  });
});

describe("POST /api/invitations — responding to an invite", () => {
  it("requires CSRF, so a cross-site POST cannot accept on the victim's behalf", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);
    const res = await invitationsRoute.POST(
      req("POST", { invitationId: INVITATION_ID, action: "accept" }, "/api/invitations")
    );
    expect(res.status).toBe(403);
    expect(dbCalls.inserts).toBe(0);
    expect(dbCalls.updates).toBe(0);
  });

  it("404s an invitation that is not the caller's or already answered", async () => {
    selectQueue.rows = [[]];
    const res = await invitationsRoute.POST(
      req("POST", { invitationId: INVITATION_ID, action: "accept" }, "/api/invitations")
    );
    expect(res.status).toBe(404);
    expect(dbCalls.inserts).toBe(0);
  });

  it("accepts an invitation with an idempotent membership upsert", async () => {
    // A second click must not explode on `folder_members_unique`.
    selectQueue.rows = [
      [{ id: INVITATION_ID, folderId: FOLDER_ID, invitedUserId: MEMBER, role: "view", invitedBy: OWNER, status: "pending" }],
      [{ id: FOLDER_ID, userId: OWNER, deletedAt: null }],
    ];
    const res = await invitationsRoute.POST(
      req("POST", { invitationId: INVITATION_ID, action: "accept" }, "/api/invitations")
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.folderId).toBe(FOLDER_ID);
    expect(dbCalls.inserts).toBe(1);
  });

  it("refuses an invitation to a folder the owner has since trashed", async () => {
    selectQueue.rows = [
      [{ id: INVITATION_ID, folderId: FOLDER_ID, invitedUserId: MEMBER, role: "view", invitedBy: OWNER, status: "pending" }],
      [{ id: FOLDER_ID, userId: OWNER, deletedAt: new Date() }],
    ];
    const res = await invitationsRoute.POST(
      req("POST", { invitationId: INVITATION_ID, action: "accept" }, "/api/invitations")
    );
    expect(res.status).toBe(410);
    // No membership is created; the dead invitation is marked instead.
    expect(dbCalls.inserts).toBe(0);
    expect(dbCalls.updates).toBe(1);
  });
});

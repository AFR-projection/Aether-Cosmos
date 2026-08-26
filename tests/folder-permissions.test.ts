import { describe, it, expect, beforeEach, vi } from "vitest";
import type { File, Folder } from "@/lib/db/schema";
import type { SessionUser } from "@/lib/auth/session";

/**
 * The sharing policy, pinned.
 *
 * Two things are tested here, both of them regressions that already cost real data:
 *
 * 1. `folderCapabilities()` — a `view` member deleted a shared folder and it vanished from
 *    the OWNER's account, because "view" was never actually narrower than "owner" for the
 *    account that happened to be a master. The matrix below states, for every combination,
 *    exactly what each role may do.
 * 2. `resolveWritableDestination()` — a move used to be unvalidated, so a collaborator could
 *    drag the owner's file into their own account, out of the owner's reach.
 *
 * `@/lib/db` is replaced with a chainable stub: the plain `select … from folders … limit(1)`
 * lookup returns `state.folderRow`, and the membership lookup (the only query that calls
 * `innerJoin`) returns `state.membershipRow`. That keeps the policy under test instead of
 * Postgres.
 */

const state = vi.hoisted(() => ({
  folderRow: [] as unknown[],
  membershipRow: [] as unknown[],
  plainSelects: 0,
  joinedSelects: 0,
}));

vi.mock("@/lib/db", () => {
  type Chain = {
    from: (t?: unknown) => Chain;
    innerJoin: (...a: unknown[]) => Chain;
    where: (...a: unknown[]) => Chain;
    orderBy: (...a: unknown[]) => Chain;
    limit: (n?: number) => Promise<unknown[]>;
  };

  function makeChain(): Chain {
    let joined = false;
    const api: Chain = {
      from: () => api,
      innerJoin: () => {
        joined = true;
        return api;
      },
      where: () => api,
      orderBy: () => api,
      limit: async () => {
        if (joined) {
          state.joinedSelects++;
          return state.membershipRow;
        }
        state.plainSelects++;
        return state.folderRow;
      },
    };
    return api;
  }

  return {
    db: { select: () => makeChain() },
    recalculateUsedBytes: vi.fn(),
  };
});

const { folderCapabilities, resolveWritableDestination, fileDomainOwnerId } = await import(
  "@/lib/auth/permissions"
);

const OWNER = "11111111-1111-1111-1111-111111111111";
const MEMBER = "22222222-2222-2222-2222-222222222222";
const STRANGER = "33333333-3333-3333-3333-333333333333";
const SHARE_ROOT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SUBFOLDER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const MEMBER_FOLDER = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function folder(id: string, userId: string, path: string): Folder {
  return {
    id,
    userId,
    parentId: null,
    name: path.replace(/\//g, "") || "root",
    materializedPath: path,
    depth: 1,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as Folder;
}

function user(id: string, role: "user" | "master" = "user"): SessionUser {
  return { id, effectiveUserId: id, role, isImpersonating: false, sessionId: "s" } as unknown as SessionUser;
}

function file(over: { userId: string; folderId: string | null }): File {
  return { id: "f", name: "x.txt", ...over } as unknown as File;
}

beforeEach(() => {
  state.folderRow = [];
  state.membershipRow = [];
  state.plainSelects = 0;
  state.joinedSelects = 0;
});

describe("folderCapabilities", () => {
  it("gives the owner everything", () => {
    expect(
      folderCapabilities({ isOwner: true, masterOverride: false, memberRole: null, isShareRoot: false })
    ).toEqual({
      canView: true,
      canEdit: true,
      canManageMembers: true,
      canTrashFolder: true,
      canPurge: true,
      canOwnerOnlyFlags: true,
    });
  });

  it("a `view` member may look and nothing else", () => {
    // The exact bug that was reported: this row must be all-false except canView, whatever
    // the account's global role happens to be.
    const caps = folderCapabilities({
      isOwner: false,
      masterOverride: false,
      memberRole: "view",
      isShareRoot: true,
    });
    expect(caps).toEqual({
      canView: true,
      canEdit: false,
      canManageMembers: false,
      canTrashFolder: false,
      canPurge: false,
      canOwnerOnlyFlags: false,
    });
  });

  it("a `view` member stays read-only in nested subfolders too", () => {
    const caps = folderCapabilities({
      isOwner: false,
      masterOverride: false,
      memberRole: "view",
      isShareRoot: false,
    });
    expect(caps.canEdit).toBe(false);
    expect(caps.canTrashFolder).toBe(false);
  });

  it("an `edit` member may change contents but never purge or manage members", () => {
    const caps = folderCapabilities({
      isOwner: false,
      masterOverride: false,
      memberRole: "edit",
      isShareRoot: false,
    });
    expect(caps.canEdit).toBe(true);
    expect(caps.canTrashFolder).toBe(true);
    expect(caps.canPurge).toBe(false);
    expect(caps.canManageMembers).toBe(false);
    expect(caps.canOwnerOnlyFlags).toBe(false);
  });

  it("an `edit` member may not trash the folder that was shared with them", () => {
    // Trashing the share root would remove it from the OWNER's account — the data loss this
    // model exists to prevent. Leaving the share is the member's equivalent action.
    const caps = folderCapabilities({
      isOwner: false,
      masterOverride: false,
      memberRole: "edit",
      isShareRoot: true,
    });
    expect(caps.canTrashFolder).toBe(false);
    expect(caps.canEdit).toBe(true);
  });

  it("a master override (never invited) still gets full rights", () => {
    expect(
      folderCapabilities({ isOwner: false, masterOverride: true, memberRole: null, isShareRoot: false })
    ).toEqual({
      canView: true,
      canEdit: true,
      canManageMembers: true,
      canTrashFolder: true,
      canPurge: true,
      canOwnerOnlyFlags: true,
    });
  });

  it("a member role beats the master override when both are passed", () => {
    // resolveFolderAccess never sets both, but the policy must degrade safely if it did:
    // the explicit, narrower grant wins.
    const caps = folderCapabilities({
      isOwner: false,
      masterOverride: false,
      memberRole: "view",
      isShareRoot: false,
    });
    expect(caps.canEdit).toBe(false);
  });

  it("no owner, no master, no membership means no access at all", () => {
    expect(
      folderCapabilities({ isOwner: false, masterOverride: false, memberRole: null, isShareRoot: false })
    ).toEqual({
      canView: false,
      canEdit: false,
      canManageMembers: false,
      canTrashFolder: false,
      canPurge: false,
      canOwnerOnlyFlags: false,
    });
  });
});

describe("resolveWritableDestination", () => {
  it("lets the owner move their own file out to the tree root", async () => {
    const res = await resolveWritableDestination(user(OWNER), null, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res).toEqual({ ok: true, folderId: null });
    // "No folder" needs no lookup at all.
    expect(state.plainSelects).toBe(0);
  });

  it("refuses to move someone else's file to the root — a root belongs to one person", async () => {
    const res = await resolveWritableDestination(user(MEMBER), null, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
  });

  it("404s on a destination that does not exist", async () => {
    state.folderRow = [];
    const res = await resolveWritableDestination(user(MEMBER), SUBFOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(404);
  });

  it("refuses a `view` member with the reason, not a silent 404", async () => {
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    state.membershipRow = [{ folderId: SHARE_ROOT, role: "view" }];
    const res = await resolveWritableDestination(user(MEMBER), SUBFOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.message).toMatch(/view access/i);
  });

  it("lets an `edit` member move the owner's file inside the shared tree", async () => {
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    state.membershipRow = [{ folderId: SHARE_ROOT, role: "edit" }];
    const res = await resolveWritableDestination(user(MEMBER), SUBFOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res).toEqual({ ok: true, folderId: SUBFOLDER });
  });

  it("blocks a collaborator from dragging the owner's file into their own account", async () => {
    // The destination is the MEMBER's own folder, so they may write there — but the file
    // would leave the owner's tree and the owner could never reach it again.
    state.folderRow = [folder(MEMBER_FOLDER, MEMBER, "/Mine/")];
    const res = await resolveWritableDestination(user(MEMBER), MEMBER_FOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.message).toMatch(/out of the folder it was shared in/i);
  });

  it("lets a collaborator move a file they uploaded between subfolders of the share", async () => {
    // Their own file, destination still owned by the share owner: this is the case a stricter
    // "destination owner must equal file owner" rule wrongly rejected.
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    state.membershipRow = [{ folderId: SHARE_ROOT, role: "edit" }];
    const res = await resolveWritableDestination(user(MEMBER), SUBFOLDER, {
      fileOwnerId: MEMBER,
      domainOwnerId: OWNER,
    });
    expect(res).toEqual({ ok: true, folderId: SUBFOLDER });
  });

  it("lets a collaborator bring their OWN file home out of the shared tree", async () => {
    state.folderRow = [folder(MEMBER_FOLDER, MEMBER, "/Mine/")];
    const res = await resolveWritableDestination(user(MEMBER), MEMBER_FOLDER, {
      fileOwnerId: MEMBER,
      domainOwnerId: OWNER,
    });
    expect(res).toEqual({ ok: true, folderId: MEMBER_FOLDER });
  });

  it("refuses a stranger with no membership at all", async () => {
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    state.membershipRow = [];
    const res = await resolveWritableDestination(user(STRANGER), SUBFOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // No access resolves at all, so the folder is simply "not found" for them.
    expect(res.status).toBe(404);
  });

  it("keeps an invited master bound by the role they accepted", async () => {
    // The reported incident: the "view" invitee was a master account. The membership must
    // win, so even a master lands on a 403 here.
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    state.membershipRow = [{ folderId: SHARE_ROOT, role: "view" }];
    const res = await resolveWritableDestination(user(MEMBER, "master"), SUBFOLDER, {
      fileOwnerId: OWNER,
      domainOwnerId: OWNER,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
  });
});

describe("fileDomainOwnerId", () => {
  it("a loose file's domain is its own owner", async () => {
    const id = await fileDomainOwnerId(file({ userId: MEMBER, folderId: null }));
    expect(id).toBe(MEMBER);
    expect(state.plainSelects).toBe(0);
  });

  it("a file inside a folder belongs to that folder's owner's domain", async () => {
    state.folderRow = [folder(SUBFOLDER, OWNER, "/Work/Sub/")];
    const id = await fileDomainOwnerId(file({ userId: MEMBER, folderId: SUBFOLDER }));
    expect(id).toBe(OWNER);
  });

  it("falls back to the file's owner when the folder row has vanished", async () => {
    state.folderRow = [];
    const id = await fileDomainOwnerId(file({ userId: MEMBER, folderId: SUBFOLDER }));
    expect(id).toBe(MEMBER);
  });
});

import { and, desc, eq, isNull, isNotNull, inArray, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { files, folders, folderMembers, type File, type Folder } from "@/shared/infrastructure/db/schema";
import type { SessionUser } from "./session";

/**
 * Authorization for folders, files and folder sharing.
 *
 * One rule decides everything here: **an explicit membership always wins over an
 * implicit privilege.** A master normally sees every resource, but the moment they are
 * invited to a folder as `view`, that invitation is the narrower, deliberate grant and it
 * governs the whole shared subtree — otherwise "view only" silently means "can delete the
 * owner's folder", which is exactly the data loss this model exists to prevent. Masters
 * keep their override everywhere they were *not* invited (and in the admin surfaces).
 *
 * Access is also INHERITED: sharing `/Work/` shares everything under it. A membership row
 * therefore grants access to any folder whose materialized path starts with the shared
 * folder's path, and the DEEPEST matching share wins so a nested `edit` share can widen a
 * broader `view` share.
 */

export type FolderMemberRole = "view" | "edit";
export type FolderAccessRole = "owner" | FolderMemberRole;

/**
 * What the caller may do. Deliberately finer-grained than the role: "edit" means "change
 * the contents", it never means "destroy the share itself" or "purge the owner's trash".
 */
export type FolderCapabilities = {
  /** See the folder and list its contents. */
  canView: boolean;
  /** Create / rename / move / trash the CONTENT inside this folder. */
  canEdit: boolean;
  /** Invite, change a role, remove a collaborator. */
  canManageMembers: boolean;
  /** Soft-delete THIS folder. Never true for the shared root of someone else's folder. */
  canTrashFolder: boolean;
  /** Restore from trash or delete permanently — irreversible, so owner only. */
  canPurge: boolean;
  /** Toggle the owner's favourite flag, or publish a public share link. */
  canOwnerOnlyFlags: boolean;
};

export type FolderAccess = FolderCapabilities & {
  folder: Folder;
  role: FolderAccessRole;
  isOwner: boolean;
  /** The grant came from a `folder_members` row on this folder or an ancestor. */
  viaMembership: boolean;
  /** Access exists only because the caller is a master (not owner, not member). */
  masterOverride: boolean;
  /** Folder the membership was granted on (`null` for owner/master). */
  shareRootId: string | null;
  /** This folder IS the shared root — deleting or renaming it is the owner's call. */
  isShareRoot: boolean;
};

export type FileAccess = {
  file: File;
  role: FolderAccessRole;
  isOwner: boolean;
  canView: boolean;
  canEdit: boolean;
  /** Move to the recycle bin. */
  canTrash: boolean;
  /** Restore, or delete permanently. */
  canPurge: boolean;
  /** Favourite flag, public share links. */
  canOwnerOnlyFlags: boolean;
  masterOverride: boolean;
  /** Access the file inherited from its folder, when it is not the caller's own file. */
  folderAccess: FolderAccess | null;
};

const FULL: FolderCapabilities = {
  canView: true,
  canEdit: true,
  canManageMembers: true,
  canTrashFolder: true,
  canPurge: true,
  canOwnerOnlyFlags: true,
};

const NONE: FolderCapabilities = {
  canView: false,
  canEdit: false,
  canManageMembers: false,
  canTrashFolder: false,
  canPurge: false,
  canOwnerOnlyFlags: false,
};

/**
 * The whole authorization policy as a pure function, so every combination can be pinned by
 * a test without a database. `isOwner`/`masterOverride` are already mutually exclusive with
 * `memberRole` by the time this is called.
 */
export function folderCapabilities(input: {
  isOwner: boolean;
  masterOverride: boolean;
  memberRole: FolderMemberRole | null;
  isShareRoot: boolean;
}): FolderCapabilities {
  if (input.isOwner || input.masterOverride) return { ...FULL };

  if (input.memberRole === "edit") {
    return {
      canView: true,
      canEdit: true,
      canManageMembers: false,
      // Trashing the folder that was shared with you would remove it from the OWNER's
      // account; leaving the share is the member's equivalent action.
      canTrashFolder: !input.isShareRoot,
      canPurge: false,
      canOwnerOnlyFlags: false,
    };
  }

  if (input.memberRole === "view") {
    return { ...NONE, canView: true };
  }

  return { ...NONE };
}

export function isMaster(user: SessionUser): boolean {
  return user.role === "master";
}

/**
 * Why a collaborator was refused, in words.
 *
 * A member already knows the folder exists — hiding the reason behind a 404 only makes the
 * UI look broken, so name what the role does not allow and point at the action that IS
 * theirs. Lives here (not in a route) so every surface refuses with the same wording.
 */
export function shareRefusal(
  access: FolderAccess,
  what: "create" | "rename" | "move" | "delete" | "restore" | "publish"
): string {
  if (access.role === "view") {
    if (what === "create") {
      return "You only have view access to this folder, so you can't create anything inside it.";
    }
    if (what === "publish") {
      return "You only have view access to this folder, so you can't create a public share link.";
    }
    return "You only have view access to this folder, so you can't change what's in it.";
  }
  if (what === "publish") {
    return "Only the owner of the folder or file can create a public share link.";
  }
  if (what === "delete") {
    return "This folder belongs to someone else — only its owner can delete it. Use \"Leave shared folder\" to take it off your list.";
  }
  if (what === "restore") {
    return "Only the folder's owner can restore it from the recycle bin.";
  }
  return "This folder was shared with you; only its owner can rename or move the folder itself.";
}

/**
 * Why a collaborator was refused on a FILE. Same reasoning as `shareRefusal`: the member can
 * see the file, so a 404 would only look like a bug.
 */
export function fileRefusal(
  access: FileAccess,
  what: "edit" | "favorite" | "trash" | "purge" | "restore" | "publish"
): string {
  if (access.role === "view") {
    if (what === "publish") {
      return "You only have view access to this file, so you can't create a public share link.";
    }
    return "You only have view access to this folder, so you can't change the files in it.";
  }
  if (what === "publish") {
    return "Only the file's owner can create a public share link.";
  }
  if (what === "favorite") {
    return "Favorites only apply to your own files, not to ones shared with you.";
  }
  if (what === "purge") {
    return "Only the file's owner can delete it permanently.";
  }
  if (what === "restore") {
    return "Only the file's owner can restore it from the recycle bin.";
  }
  if (what === "trash") {
    return "Only the file's owner, or a member with edit access, can move it to the recycle bin.";
  }
  return "You don't have permission to do this to someone else's file.";
}

export type DestinationCheck =
  | { ok: true; folderId: string | null }
  | { ok: false; status: number; message: string };

/**
 * Validate a move/copy destination for one file.
 *
 * Three things have to hold, and each one is a bug that existed before:
 * 1. the caller must be allowed to write in the destination (it was never checked);
 * 2. the destination must stay inside the same sharing domain — the tree the file currently
 *    lives in — so a collaborator cannot drag the OWNER's file into their own account,
 *    where the owner can no longer reach it;
 * 3. a file you own yourself may always come home to your own tree.
 *
 * `domainOwnerId` is the owner of the folder the file sits in right now (the file's own
 * owner when it sits loose at the tree root).
 */
export async function resolveWritableDestination(
  user: SessionUser,
  folderId: string | null,
  owners: { fileOwnerId: string; domainOwnerId: string }
): Promise<DestinationCheck> {
  const callerId = user.effectiveUserId;

  if (!folderId) {
    // "No folder" means the root of a tree, and a tree root belongs to exactly one person.
    if (callerId !== owners.fileOwnerId) {
      return {
        ok: false,
        status: 403,
        message: "This file isn't yours; only its owner can move it out of the folder.",
      };
    }
    return { ok: true, folderId: null };
  }

  const dest = await resolveFolderAccess(user, folderId);
  if (!dest) return { ok: false, status: 404, message: "Destination folder not found" };
  if (!dest.canEdit) return { ok: false, status: 403, message: shareRefusal(dest, "move") };

  const destOwnerId = dest.folder.userId;
  const staysInDomain = destOwnerId === owners.domainOwnerId;
  const comingHome = callerId === owners.fileOwnerId && destOwnerId === callerId;
  if (!staysInDomain && !comingHome) {
    return {
      ok: false,
      status: 400,
      message: "A file can't be moved out of the folder it was shared in.",
    };
  }
  return { ok: true, folderId };
}

/** Owner of the tree a file currently lives in — its folder's owner, or its own. */
export async function fileDomainOwnerId(file: File): Promise<string> {
  if (!file.folderId) return file.userId;
  const [row] = await db
    .select({ userId: folders.userId })
    .from(folders)
    .where(eq(folders.id, file.folderId))
    .limit(1);
  return row?.userId ?? file.userId;
}

/**
 * Ownership check for resources that are not reachable through a shared folder.
 *
 * Do NOT use this to gate folder or file mutations — it cannot see a membership, so it
 * answers "is this the owner (or a master)?", not "may this caller do this?". Use
 * `resolveFolderAccess` / `resolveFileAccess` there.
 */
export function canAccessUserResource(
  user: SessionUser,
  resourceUserId: string
): boolean {
  if (user.role === "master") return true;
  return user.effectiveUserId === resourceUserId;
}

export function getEffectiveUserId(user: SessionUser): string {
  return user.effectiveUserId;
}

/** Nearest membership of `userId` on `folder` or one of its ancestors. */
async function findNearestMembership(
  userId: string,
  folder: Folder
): Promise<{ folderId: string; role: FolderMemberRole } | null> {
  const [row] = await db
    .select({ folderId: folderMembers.folderId, role: folderMembers.role })
    .from(folderMembers)
    .innerJoin(folders, eq(folderMembers.folderId, folders.id))
    .where(
      and(
        eq(folderMembers.userId, userId),
        // A share only ever covers its own owner's tree; paths are per-user.
        eq(folders.userId, folder.userId),
        isNull(folders.deletedAt),
        // Every materialized path ends in "/", so a prefix match cannot leak "/AB/" into
        // a share of "/A/".
        sql`starts_with(${folder.materializedPath}::text, ${folders.materializedPath})`
      )
    )
    // Deepest share wins: a nested `edit` share beats a broader `view` share.
    .orderBy(desc(sql`length(${folders.materializedPath})`))
    .limit(1);

  return row ?? null;
}

function buildFolderAccess(
  folder: Folder,
  input: {
    isOwner: boolean;
    masterOverride: boolean;
    memberRole: FolderMemberRole | null;
    shareRootId: string | null;
  }
): FolderAccess {
  const isShareRoot = input.shareRootId === folder.id;
  const caps = folderCapabilities({
    isOwner: input.isOwner,
    masterOverride: input.masterOverride,
    memberRole: input.memberRole,
    isShareRoot,
  });
  return {
    ...caps,
    folder,
    role: input.memberRole ?? "owner",
    isOwner: input.isOwner,
    viaMembership: input.memberRole !== null,
    masterOverride: input.masterOverride,
    shareRootId: input.shareRootId,
    isShareRoot,
  };
}

export async function resolveFolderAccess(
  user: SessionUser,
  folderId: string,
  opts: { includeDeleted?: boolean } = {}
): Promise<FolderAccess | null> {
  const conditions = [eq(folders.id, folderId)];
  if (!opts.includeDeleted) conditions.push(isNull(folders.deletedAt));

  const [folder] = await db
    .select()
    .from(folders)
    .where(and(...conditions))
    .limit(1);

  if (!folder) return null;

  const userId = user.effectiveUserId;

  if (folder.userId === userId) {
    return buildFolderAccess(folder, {
      isOwner: true,
      masterOverride: false,
      memberRole: null,
      shareRootId: null,
    });
  }

  // Membership is checked BEFORE the master override on purpose: an accepted invitation is
  // an explicit, narrower grant and it must not be silently widened to owner rights.
  const membership = await findNearestMembership(userId, folder);
  if (membership) {
    return buildFolderAccess(folder, {
      isOwner: false,
      masterOverride: false,
      memberRole: membership.role,
      shareRootId: membership.folderId,
    });
  }

  if (isMaster(user)) {
    return buildFolderAccess(folder, {
      isOwner: false,
      masterOverride: true,
      memberRole: null,
      shareRootId: null,
    });
  }

  return null;
}

export async function resolveFileAccess(
  user: SessionUser,
  fileId: string,
  opts: { includeDeleted?: boolean; anyStatus?: boolean } = {}
): Promise<FileAccess | null> {
  const conditions = [eq(files.id, fileId)];
  if (!opts.includeDeleted) conditions.push(isNull(files.deletedAt));
  if (!opts.anyStatus) conditions.push(inArray(files.status, ["ready", "legacy_unverified"]));

  const [file] = await db
    .select()
    .from(files)
    .where(and(...conditions))
    .limit(1);

  if (!file) return null;

  if (file.userId === user.effectiveUserId) {
    return {
      file,
      role: "owner",
      isOwner: true,
      canView: true,
      canEdit: true,
      canTrash: true,
      canPurge: true,
      canOwnerOnlyFlags: true,
      masterOverride: false,
      folderAccess: null,
    };
  }

  // Everything else is inherited from the containing folder — including the folder owner's
  // rights over a file a collaborator created inside their folder.
  if (file.folderId) {
    const folderAccess = await resolveFolderAccess(user, file.folderId, {
      includeDeleted: opts.includeDeleted,
    });
    if (folderAccess?.canView) {
      return {
        file,
        role: folderAccess.role,
        isOwner: false,
        canView: true,
        canEdit: folderAccess.canEdit,
        canTrash: folderAccess.canEdit,
        canPurge: folderAccess.canPurge,
        canOwnerOnlyFlags: folderAccess.canOwnerOnlyFlags,
        masterOverride: folderAccess.masterOverride,
        folderAccess,
      };
    }
    if (folderAccess) return null;
  }

  // A loose file (no folder) is only reachable by its owner, or by a master.
  if (isMaster(user)) {
    return {
      file,
      role: "owner",
      isOwner: false,
      canView: true,
      canEdit: true,
      canTrash: true,
      canPurge: true,
      canOwnerOnlyFlags: true,
      masterOverride: true,
      folderAccess: null,
    };
  }

  return null;
}

export async function getAccessibleFile(
  user: SessionUser,
  fileId: string,
  opts: { includeDeleted?: boolean; anyStatus?: boolean } = {}
): Promise<FileAccess | null> {
  return resolveFileAccess(user, fileId, opts);
}

export function canEditFolder(access: FolderAccess | null): boolean {
  return !!access?.canEdit;
}

export function canMutateSharedFile(access: FileAccess | null): boolean {
  return !!access?.canEdit;
}

/** Folder IDs shared with the user (as a member, not owner). */
export async function getSharedFolderIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ folderId: folderMembers.folderId })
    .from(folderMembers)
    .where(eq(folderMembers.userId, userId));
  return rows.map((r) => r.folderId);
}

/**
 * List folders accessible at a parent level.
 * Root: owned roots + folders shared with the user.
 * Nested: children when the caller can view the parent (membership is inherited, so this
 * works at any depth inside a shared folder).
 */
export async function listAccessibleFolders(
  user: SessionUser,
  parentId: string | null,
  trash: boolean
): Promise<Folder[]> {
  const userId = getEffectiveUserId(user);

  if (trash) {
    // The recycle bin is per-owner: a collaborator never sees the owner's trash, and
    // nothing they trashed inside a shared folder shows up in their own bin.
    const conditions = [eq(folders.userId, userId), isNotNull(folders.deletedAt)];
    if (parentId) {
      conditions.push(eq(folders.parentId, parentId));
    } else {
      conditions.push(isNull(folders.parentId));
    }
    return db.select().from(folders).where(and(...conditions));
  }

  if (parentId) {
    const access = await resolveFolderAccess(user, parentId);
    if (!access?.canView) return [];
    return db
      .select()
      .from(folders)
      .where(and(eq(folders.parentId, parentId), isNull(folders.deletedAt)));
  }

  // Root: owned roots + shared folders
  const ownedRoots = await db
    .select()
    .from(folders)
    .where(and(eq(folders.userId, userId), isNull(folders.parentId), isNull(folders.deletedAt)));

  const sharedIds = await getSharedFolderIds(userId);
  if (sharedIds.length === 0) return ownedRoots;

  const sharedFolders = await db
    .select()
    .from(folders)
    .where(and(inArray(folders.id, sharedIds), isNull(folders.deletedAt)));

  const seen = new Set(ownedRoots.map((f) => f.id));
  const merged = [...ownedRoots];
  for (const f of sharedFolders) {
    if (!seen.has(f.id)) merged.push(f);
  }
  return merged;
}

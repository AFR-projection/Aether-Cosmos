import { and, eq, isNull, isNotNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { files, folders, folderMembers, type File, type Folder } from "@/lib/db/schema";
import type { SessionUser } from "./session";

export type FolderAccessRole = "owner" | "edit" | "view";

export type FolderAccess = {
  folder: Folder;
  role: FolderAccessRole;
  canView: boolean;
  canEdit: boolean;
  canManageMembers: boolean;
};

export type FileAccess = {
  file: File;
  role: FolderAccessRole;
  canView: boolean;
  canEdit: boolean;
};

export function isMaster(user: SessionUser): boolean {
  return user.role === "master";
}

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

export async function resolveFolderAccess(
  user: SessionUser,
  folderId: string
): Promise<FolderAccess | null> {
  const [folder] = await db
    .select()
    .from(folders)
    .where(and(eq(folders.id, folderId), isNull(folders.deletedAt)))
    .limit(1);

  if (!folder) return null;

  if (isMaster(user) || folder.userId === user.effectiveUserId) {
    return {
      folder,
      role: "owner",
      canView: true,
      canEdit: true,
      canManageMembers: true,
    };
  }

  const [member] = await db
    .select()
    .from(folderMembers)
    .where(
      and(
        eq(folderMembers.folderId, folderId),
        eq(folderMembers.userId, user.effectiveUserId)
      )
    )
    .limit(1);

  if (!member) return null;

  const canEdit = member.role === "edit";
  return {
    folder,
    role: member.role,
    canView: true,
    canEdit,
    canManageMembers: false,
  };
}

export async function resolveFileAccess(
  user: SessionUser,
  fileId: string
): Promise<FileAccess | null> {
  const [file] = await db
    .select()
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deletedAt), eq(files.status, "ready")))
    .limit(1);

  if (!file) return null;

  if (isMaster(user) || file.userId === user.effectiveUserId) {
    return { file, role: "owner", canView: true, canEdit: true };
  }

  if (file.folderId) {
    const folderAccess = await resolveFolderAccess(user, file.folderId);
    if (folderAccess) {
      return {
        file,
        role: folderAccess.role,
        canView: folderAccess.canView,
        canEdit: folderAccess.canEdit,
      };
    }
  }

  return null;
}

export async function getAccessibleFile(
  user: SessionUser,
  fileId: string
): Promise<FileAccess | null> {
  return resolveFileAccess(user, fileId);
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
 * Nested: children if user owns or has membership on the parent.
 */
export async function listAccessibleFolders(
  user: SessionUser,
  parentId: string | null,
  trash: boolean
): Promise<Folder[]> {
  const userId = getEffectiveUserId(user);

  if (trash) {
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

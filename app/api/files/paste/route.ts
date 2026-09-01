import { NextRequest } from "next/server";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db, recalculateUsedBytes } from "@/shared/infrastructure/db";
import {
  fileContents,
  files,
  folders,
  users,
  type Folder,
} from "@/shared/infrastructure/db/schema";
import { getClientIp, requireAuth } from "@/shared/lib/auth/session";
import {
  fileDomainOwnerId,
  fileRefusal,
  getEffectiveUserId,
  resolveFileAccess,
  resolveFolderAccess,
  resolveWritableDestination,
  shareRefusal,
} from "@/shared/lib/auth/permissions";
import { logActivity } from "@/shared/lib/auth/audit";
import { checkUserApiRateLimit, validateCsrf } from "@/shared/lib/security";
import { apiError, apiSuccess, handleApiError } from "@/shared/api/response";
import { buildR2Key, copyR2Object, deleteR2Object } from "@files/infrastructure/storage/r2";
import { cacheDelPattern } from "@/shared/infrastructure/cache/redis";
import { getAdminSettings } from "@/shared/lib/settings/admin-settings";
import { escapeLike } from "@/shared/lib/utils";
import { nextAvailableName } from "@files/domain/services/paste-plan";

/**
 * `POST /api/files/paste` — the server half of Explorer-style copy / cut → paste.
 *
 * One route, three operations, because a paste is not one request: it is a question
 * followed by as much work as the caller can chew through.
 *
 * - `plan` reads only. It resolves every clipboard id against the caller's real
 *   permissions, walks the subtree of any folder on the clipboard, adds up the bytes,
 *   finds the name collisions and answers whether the quota can take it. Nothing is
 *   written, so the conflict dialog can be shown *before* anything happens rather than
 *   halfway through.
 * - `folders` builds the destination skeleton for a copy (or reparents folders for a
 *   cut) and hands back an `oldId → newId` map plus the list of files to copy and where
 *   each one goes. That map is what keeps the whole flow stateless: no server-side
 *   paste session to expire, resume or leak.
 * - `files` does a bounded chunk of the actual per-file work, so a 400-file paste is
 *   many small requests the browser can report progress on and stop between, instead of
 *   one request that either finishes or times out.
 *
 * Why not a background job: a `copyJobs` table would need a migration, and the
 * migrations here are applied by hand. Chunking gives progress and cancellation without
 * one. The trade-off is that closing the tab mid-paste leaves the copy partly done —
 * the same thing that happens when you close Explorer's progress window.
 */

/** `CopyObjectCommand` is single-part; past this an R2 copy needs a multipart flow. */
const MAX_SINGLE_PART_COPY_BYTES = 5 * 1024 * 1024 * 1024;

/** Files per `files` request. Small enough that a chunk always finishes well inside the
 * platform's request timeout, large enough that the round trips are not the bottleneck. */
const MAX_FILES_PER_CHUNK = 20;

/** Ceilings on one paste, so a mis-click on a huge tree cannot pin the database. */
const MAX_SUBTREE_FOLDERS = 500;
const MAX_SUBTREE_FILES = 2000;

/** Statuses a file must have to be worth copying — anything else has no usable object. */
const COPYABLE_STATUSES = ["ready", "legacy_unverified"] as const;

const idSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(255);

const planSchema = z.object({
  op: z.literal("plan"),
  mode: z.enum(["copy", "cut"]),
  destinationFolderId: idSchema.nullable(),
  entries: z
    .array(z.object({ kind: z.enum(["file", "folder"]), id: idSchema }))
    .min(1)
    .max(500),
});

const foldersSchema = z.object({
  op: z.literal("folders"),
  mode: z.enum(["copy", "cut"]),
  destinationFolderId: idSchema.nullable(),
  items: z.array(z.object({ id: idSchema, name: nameSchema })).min(1).max(100),
});

const filesSchema = z.object({
  op: z.literal("files"),
  mode: z.enum(["copy", "cut"]),
  items: z
    .array(
      z.object({
        id: idSchema,
        targetFolderId: idSchema.nullable(),
        name: nameSchema,
        /** Trash the same-named file at the destination first. */
        replace: z.boolean().optional(),
      })
    )
    .min(1)
    .max(MAX_FILES_PER_CHUNK),
});

const bodySchema = z.discriminatedUnion("op", [planSchema, foldersSchema, filesSchema]);

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const userId = getEffectiveUserId(sessionUser);
    const settings = await getAdminSettings();
    const rl = await checkUserApiRateLimit(userId, settings.rateLimitPerMinute);
    if (!rl.allowed) return apiError("Rate limit exceeded", 429);

    const body = bodySchema.parse(await request.json());

    if (body.op === "plan") return await handlePlan(sessionUser, userId, body);
    if (body.op === "folders") return await handleFolders(sessionUser, userId, body, request);
    return await handleFiles(sessionUser, body, request);
  } catch (error) {
    return handleApiError(error);
  }
}

type SessionUser = Awaited<ReturnType<typeof requireAuth>>;

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * A clipboard may hold 500 files and each one needs its own capability resolution, which
 * is a query. Sequentially that is 500 round trips before the dialog can open; all at
 * once it is 500 concurrent connections. A small window is the only sensible middle.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

const RESOLVE_CONCURRENCY = 8;

type Destination = {
  /** `null` at the account root. */
  folder: Folder | null;
  /** Whose tree the paste lands in — the folder's owner, or the caller at their root. */
  ownerId: string;
  /** The destination folder and every ancestor, for the "inside itself" check. */
  pathIds: Set<string>;
};

/**
 * Resolve where a paste is aimed, refusing early if the caller may not write there.
 *
 * The ancestor walk is a recursive CTE rather than a prefix match on `materialized_path`,
 * because the path is built from folder *names*: a folder called `50%` would turn a LIKE
 * pattern into a wildcard, and a folder called `a` would match `a/b/` from another
 * branch. Ids do not have that problem.
 */
async function loadDestination(
  user: SessionUser,
  folderId: string | null
): Promise<Destination | { error: ReturnType<typeof apiError> }> {
  if (!folderId) {
    return { folder: null, ownerId: getEffectiveUserId(user), pathIds: new Set() };
  }

  const access = await resolveFolderAccess(user, folderId);
  if (!access) return { error: apiError("Destination folder not found", 404) };
  if (!access.canEdit) return { error: apiError(shareRefusal(access, "create"), 403) };

  const rows = await db.execute(sql`
    WITH RECURSIVE ancestry AS (
      SELECT id, parent_id FROM ${folders} WHERE id = ${folderId}
      UNION ALL
      SELECT f.id, f.parent_id
      FROM ${folders} f
      JOIN ancestry a ON f.id = a.parent_id
    )
    SELECT id FROM ancestry
  `);

  const pathIds = new Set(
    (rows as unknown as Array<{ id: string }>).map((row) => row.id)
  );
  // The CTE seeds itself with the destination, but a driver that returns nothing must not
  // silently turn the self-paste check off.
  pathIds.add(folderId);

  return { folder: access.folder, ownerId: access.folder.userId, pathIds };
}

type SubtreeFolder = {
  id: string;
  userId: string;
  parentId: string | null;
  name: string;
  materializedPath: string;
  depth: number;
};

/**
 * Every folder inside (and including) the given roots.
 *
 * `escapeLike` rather than the `escapeRegex` used elsewhere in the folder routes: the
 * pattern goes to LIKE, so `%` and `_` are the characters that have to be neutralised,
 * and a folder named `100%_done` would otherwise match half the tree.
 */
async function loadSubtreeFolders(roots: SubtreeFolder[]): Promise<SubtreeFolder[]> {
  if (roots.length === 0) return [];

  const clauses = roots.map((root) =>
    and(
      eq(folders.userId, root.userId),
      like(folders.materializedPath, `${escapeLike(root.materializedPath)}%`)
    )
  );

  const rows = await db
    .select({
      id: folders.id,
      userId: folders.userId,
      parentId: folders.parentId,
      name: folders.name,
      materializedPath: folders.materializedPath,
      depth: folders.depth,
    })
    .from(folders)
    .where(and(isNull(folders.deletedAt), clauses.length === 1 ? clauses[0] : or(...clauses)))
    .limit(MAX_SUBTREE_FOLDERS + 1);

  // Two clipboard folders can nest inside one another; de-duplicate by id.
  const unique = new Map(rows.map((row) => [row.id, row]));
  return [...unique.values()];
}

/** Files that live directly in any of the given folders. */
async function loadFilesIn(folderIds: string[]) {
  if (folderIds.length === 0) return [];
  return await db
    .select({
      id: files.id,
      name: files.name,
      sizeBytes: files.sizeBytes,
      folderId: files.folderId,
      userId: files.userId,
    })
    .from(files)
    .where(
      and(
        inArray(files.folderId, folderIds),
        isNull(files.deletedAt),
        inArray(files.status, [...COPYABLE_STATUSES])
      )
    )
    .limit(MAX_SUBTREE_FILES + 1);
}

/** Names already in use at the destination, split by kind — they are separate tables. */
async function loadExistingNames(destination: Destination) {
  const folderRows = await db
    .select({ name: folders.name })
    .from(folders)
    .where(
      and(
        eq(folders.userId, destination.ownerId),
        destination.folder
          ? eq(folders.parentId, destination.folder.id)
          : isNull(folders.parentId),
        isNull(folders.deletedAt)
      )
    );

  const fileRows = await db
    .select({ name: files.name })
    .from(files)
    .where(
      and(
        eq(files.userId, destination.ownerId),
        destination.folder ? eq(files.folderId, destination.folder.id) : isNull(files.folderId),
        isNull(files.deletedAt)
      )
    );

  return {
    folders: folderRows.map((row) => row.name),
    files: fileRows.map((row) => row.name),
  };
}

/** Storage headroom for one account, and whether `requiredBytes` fits in it. */
async function quotaVerdict(ownerId: string, requiredBytes: number) {
  const [owner] = await db
    .select({
      quotaBytes: users.quotaBytes,
      usedBytes: users.usedBytes,
      reservedBytes: users.reservedBytes,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);

  // No row means the account vanished mid-request; there is nothing to enforce against
  // and the writes below will fail on their own foreign keys.
  if (!owner) return null;

  const committed = owner.usedBytes + owner.reservedBytes;
  return {
    ownerId,
    ok: committed + requiredBytes <= owner.quotaBytes,
    quotaBytes: owner.quotaBytes,
    usedBytes: owner.usedBytes,
    remainingBytes: Math.max(0, owner.quotaBytes - committed),
    requiredBytes,
  };
}

/**
 * Answer everything the browser needs to know before it starts pasting.
 *
 * Read-only, and deliberately generous about partial failure: an id that no longer
 * resolves is reported as `missing` rather than failing the whole plan, because the most
 * common reason for one is a clipboard that outlived the file — and the useful response
 * to that is "these three are gone, paste the other seven", not a dead end.
 */
async function handlePlan(
  user: SessionUser,
  userId: string,
  body: z.infer<typeof planSchema>
) {
  const destination = await loadDestination(user, body.destinationFolderId);
  if ("error" in destination) return destination.error;

  const folderIds = body.entries.filter((e) => e.kind === "folder").map((e) => e.id);
  const fileIds = body.entries.filter((e) => e.kind === "file").map((e) => e.id);

  const missing: string[] = [];
  const denied: string[] = [];

  /* ── folders on the clipboard ── */

  const folderAccesses = await mapLimit(folderIds, RESOLVE_CONCURRENCY, async (id) => ({
    id,
    access: await resolveFolderAccess(user, id),
  }));

  const roots: SubtreeFolder[] = [];
  for (const { id, access } of folderAccesses) {
    if (!access?.canView) {
      missing.push(id);
      continue;
    }
    // Geometry is checked here as well as in the browser: between the copy and the paste
    // the destination may have been moved *into* the folder being pasted.
    if (destination.pathIds.has(id)) {
      return apiError(
        id === body.destinationFolderId
          ? "A folder can't be pasted into itself."
          : "A folder can't be pasted into a folder inside it.",
        400,
        { code: id === body.destinationFolderId ? "PASTE_INTO_SELF" : "PASTE_INTO_DESCENDANT" }
      );
    }
    // Same rule the folder move uses: a folder belongs to one account's tree, and its
    // materialized path and its owner's quota have to agree about which one.
    if (access.folder.userId !== destination.ownerId) {
      return apiError("A folder can't be pasted into another owner's account.", 400, {
        code: "PASTE_CROSS_ACCOUNT",
      });
    }
    if (body.mode === "cut" && (!access.canEdit || (access.isShareRoot && !access.isOwner))) {
      denied.push(id);
      continue;
    }
    roots.push({
      id: access.folder.id,
      userId: access.folder.userId,
      parentId: access.folder.parentId,
      name: access.folder.name,
      materializedPath: access.folder.materializedPath,
      depth: access.folder.depth,
    });
  }

  /* ── files on the clipboard ── */

  // Both lookups depend only on a pair of ids, and a selection almost always shares them,
  // so memoising turns "a query per file" into "a query per distinct destination rule".
  const domainOwners = new Map<string, Promise<string>>();
  const destinationChecks = new Map<string, Promise<{ ok: boolean }>>();

  type PlanFile = {
    id: string;
    name: string;
    sizeBytes: number;
    ownerId: string;
    isNote: boolean;
  };
  type FileOutcome =
    | { outcome: "missing" | "denied"; id: string }
    | { outcome: "ok"; file: PlanFile };

  const fileResults = await mapLimit<string, FileOutcome>(
    fileIds,
    RESOLVE_CONCURRENCY,
    async (id) => {
      const access = await resolveFileAccess(user, id);
      if (!access?.canView) return { outcome: "missing", id };
      if (body.mode === "cut" && !access.canEdit) return { outcome: "denied", id };

      const file = access.file;
      const domainKey = file.folderId ?? `root:${file.userId}`;
      if (!domainOwners.has(domainKey)) domainOwners.set(domainKey, fileDomainOwnerId(file));
      const domainOwnerId = await domainOwners.get(domainKey)!;

      const destKey = `${file.userId}|${domainOwnerId}`;
      if (!destinationChecks.has(destKey)) {
        destinationChecks.set(
          destKey,
          resolveWritableDestination(user, body.destinationFolderId, {
            fileOwnerId: file.userId,
            domainOwnerId,
          })
        );
      }
      const check = await destinationChecks.get(destKey)!;
      if (!check.ok) return { outcome: "denied", id };

      return {
        outcome: "ok",
        file: {
          id: file.id,
          name: file.name,
          sizeBytes: file.sizeBytes,
          ownerId: file.userId,
          isNote: file.isNote ?? false,
        },
      };
    }
  );

  // `flatMap` rather than `filter`, because a filter callback does not narrow a union.
  const topFiles = fileResults.flatMap((r) => (r.outcome === "ok" ? [r.file] : []));
  for (const result of fileResults) {
    if (result.outcome === "missing") missing.push(result.id);
    if (result.outcome === "denied") denied.push(result.id);
  }

  /* ── what the subtrees add ── */

  const subtreeFolders = await loadSubtreeFolders(roots);
  if (subtreeFolders.length > MAX_SUBTREE_FOLDERS) {
    return apiError(
      `That's more than ${MAX_SUBTREE_FOLDERS} folders in one paste. Paste it in smaller pieces.`,
      400,
      { code: "PASTE_TOO_MANY_FOLDERS", limit: MAX_SUBTREE_FOLDERS }
    );
  }

  // A cut moves rows; only a copy has to find, weigh and re-create the contents.
  const subtreeFiles =
    body.mode === "copy" ? await loadFilesIn(subtreeFolders.map((f) => f.id)) : [];
  if (subtreeFiles.length > MAX_SUBTREE_FILES) {
    return apiError(
      `That's more than ${MAX_SUBTREE_FILES} files in one paste. Paste it in smaller pieces.`,
      400,
      { code: "PASTE_TOO_MANY_FILES", limit: MAX_SUBTREE_FILES }
    );
  }

  const allFiles = [
    ...topFiles.map((f) => ({
      id: f.id,
      name: f.name,
      sizeBytes: f.sizeBytes,
      ownerId: f.ownerId,
    })),
    ...subtreeFiles.map((f) => ({
      id: f.id,
      name: f.name,
      sizeBytes: f.sizeBytes,
      ownerId: f.userId,
    })),
  ];

  const oversized = allFiles
    .filter((f) => f.sizeBytes > MAX_SINGLE_PART_COPY_BYTES)
    .map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes }));

  /* ── quota ── */

  // A cut does not change how many bytes are stored, so it never needs headroom.
  let quota: NonNullable<Awaited<ReturnType<typeof quotaVerdict>>>[] = [];
  if (body.mode === "copy") {
    const oversizedIds = new Set(oversized.map((o) => o.id));
    const perOwner = new Map<string, number>();
    for (const file of allFiles) {
      if (oversizedIds.has(file.id)) continue;
      perOwner.set(file.ownerId, (perOwner.get(file.ownerId) ?? 0) + file.sizeBytes);
    }
    quota = (
      await Promise.all([...perOwner].map(([owner, bytes]) => quotaVerdict(owner, bytes)))
    ).flatMap((v) => (v ? [v] : []));
  }

  const existing = await loadExistingNames(destination);

  return apiSuccess({
    mode: body.mode,
    destinationFolderId: body.destinationFolderId,
    destinationOwnerId: destination.ownerId,
    /** Top-level items, in clipboard order, that the paste can actually act on. */
    items: [
      ...roots.map((f) => ({ kind: "folder" as const, id: f.id, name: f.name, sizeBytes: 0 })),
      ...topFiles.map((f) => ({
        kind: "file" as const,
        id: f.id,
        name: f.name,
        sizeBytes: f.sizeBytes,
        isNote: f.isNote,
      })),
    ],
    missing,
    denied,
    existing,
    totals: {
      folders: subtreeFolders.length,
      files: allFiles.length,
      bytes: allFiles.reduce((sum, f) => sum + f.sizeBytes, 0),
    },
    oversized,
    quota,
    limits: {
      maxFilesPerChunk: MAX_FILES_PER_CHUNK,
      maxSubtreeFolders: MAX_SUBTREE_FOLDERS,
      maxSubtreeFiles: MAX_SUBTREE_FILES,
      maxCopyBytes: MAX_SINGLE_PART_COPY_BYTES,
    },
    callerId: userId,
  });
}

/** Materialized path + depth for a child called `name` under `parent` (null = tree root). */
function pathUnder(
  parent: { materializedPath: string; depth: number } | null,
  name: string
): { materializedPath: string; depth: number } {
  if (!parent) return { materializedPath: `/${name}/`, depth: 0 };
  return { materializedPath: `${parent.materializedPath}${name}/`, depth: parent.depth + 1 };
}

/**
 * Move the folders, or lay down the whole destination skeleton for a copy.
 *
 * The skeleton is created in one shot, before any file is copied, and the `oldId → newId`
 * map goes back to the caller. That is what lets the file copying be a series of
 * independent, retryable chunks: every chunk already knows exactly which folder each file
 * belongs in, so no request depends on any other request's memory.
 */
async function handleFolders(
  user: SessionUser,
  userId: string,
  body: z.infer<typeof foldersSchema>,
  request: NextRequest
) {
  const destination = await loadDestination(user, body.destinationFolderId);
  if ("error" in destination) return destination.error;

  const ip = getClientIp(request);
  const destinationId = destination.folder?.id ?? null;

  const resolved = await mapLimit(body.items, RESOLVE_CONCURRENCY, async (item) => ({
    item,
    access: await resolveFolderAccess(user, item.id),
  }));

  const roots: Array<{ source: SubtreeFolder; requestedName: string }> = [];
  const skipped: string[] = [];

  for (const { item, access } of resolved) {
    if (!access?.canView) {
      skipped.push(item.id);
      continue;
    }
    if (destination.pathIds.has(item.id)) {
      return apiError(
        item.id === destinationId
          ? "A folder can't be pasted into itself."
          : "A folder can't be pasted into a folder inside it.",
        400,
        { code: item.id === destinationId ? "PASTE_INTO_SELF" : "PASTE_INTO_DESCENDANT" }
      );
    }
    if (access.folder.userId !== destination.ownerId) {
      return apiError("A folder can't be pasted into another owner's account.", 400, {
        code: "PASTE_CROSS_ACCOUNT",
      });
    }
    if (body.mode === "cut") {
      if (!access.canEdit || (access.isShareRoot && !access.isOwner)) {
        return apiError(shareRefusal(access, "move"), 403);
      }
      // Already where it is being sent: a move that would change nothing.
      if (access.folder.parentId === destinationId) {
        skipped.push(item.id);
        continue;
      }
    }
    roots.push({
      source: {
        id: access.folder.id,
        userId: access.folder.userId,
        parentId: access.folder.parentId,
        name: access.folder.name,
        materializedPath: access.folder.materializedPath,
        depth: access.folder.depth,
      },
      requestedName: item.name,
    });
  }

  if (roots.length === 0) {
    return apiSuccess({ folderMap: {}, files: [], created: 0, moved: 0, skipped });
  }

  const ownerId = destination.ownerId;
  cacheDelPattern(`search:${ownerId}:*`).catch(() => {});

  // Re-resolve names against the destination as it is *now*. The client picked names when
  // the conflict dialog opened; another tab may have used one since.
  const existing = await loadExistingNames(destination);
  const takenFolderNames = new Set(existing.folders);
  if (body.mode === "cut") {
    // A folder being moved out of the destination cannot collide with itself.
    for (const root of roots) {
      if (root.source.parentId === destinationId) takenFolderNames.delete(root.source.name);
    }
  }

  if (body.mode === "cut") {
    let moved = 0;
    for (const root of roots) {
      const name = nextAvailableName(root.requestedName, takenFolderNames);
      takenFolderNames.add(name);

      const oldPath = root.source.materializedPath;
      const { materializedPath: newPath, depth } = pathUnder(destination.folder, name);

      await db
        .update(folders)
        .set({
          parentId: destinationId,
          name,
          materializedPath: newPath,
          depth,
          updatedAt: new Date(),
        })
        .where(eq(folders.id, root.source.id));

      // The subtree rewrite is scoped to the OWNER's rows, not the caller's: a
      // collaborator moving someone else's folder must still fix that owner's children.
      await db.execute(sql`
        UPDATE ${folders}
        SET materialized_path = CONCAT(${newPath}, SUBSTRING(materialized_path, ${oldPath.length + 1})),
            depth = depth + ${depth - root.source.depth},
            updated_at = NOW()
        WHERE user_id = ${root.source.userId}
          AND materialized_path LIKE ${`${escapeLike(oldPath)}%`}
          AND id != ${root.source.id}
      `);

      await logActivity(user, "move", {
        resourceType: "folder",
        resourceId: root.source.id,
        metadata: { via: "paste", destination: destinationId },
        ip,
      });
      moved++;
    }
    return apiSuccess({ folderMap: {}, files: [], created: 0, moved, skipped });
  }

  /* ── copy: build the mirror tree ── */

  const subtree = await loadSubtreeFolders(roots.map((r) => r.source));
  if (subtree.length > MAX_SUBTREE_FOLDERS) {
    return apiError(
      `That's more than ${MAX_SUBTREE_FOLDERS} folders in one paste. Paste it in smaller pieces.`,
      400,
      { code: "PASTE_TOO_MANY_FOLDERS", limit: MAX_SUBTREE_FOLDERS }
    );
  }

  const rootIds = new Set(roots.map((r) => r.source.id));
  // Shallowest first, so a folder's new parent always exists in the map before it is read.
  const ordered = [...subtree].sort((a, b) => a.depth - b.depth);

  type Mirror = { id: string; materializedPath: string; depth: number };
  const mirror = new Map<string, Mirror>();
  const rows: Array<{
    id: string;
    userId: string;
    parentId: string | null;
    name: string;
    materializedPath: string;
    depth: number;
  }> = [];

  for (const folder of ordered) {
    const root = roots.find((r) => r.source.id === folder.id);

    let parentId: string | null;
    let parent: Mirror | { materializedPath: string; depth: number } | null;
    let name: string;

    if (root && rootIds.has(folder.id)) {
      name = nextAvailableName(root.requestedName, takenFolderNames);
      takenFolderNames.add(name);
      parentId = destinationId;
      parent = destination.folder;
    } else {
      const mapped = folder.parentId ? mirror.get(folder.parentId) : undefined;
      // A folder whose parent is not in the mirror is not actually inside anything we are
      // copying — a stale path row. Leaving it out is safer than guessing a parent.
      if (!mapped) continue;
      name = folder.name;
      parentId = mapped.id;
      parent = mapped;
    }

    const id = crypto.randomUUID();
    const { materializedPath, depth } = pathUnder(parent, name);
    mirror.set(folder.id, { id, materializedPath, depth });
    rows.push({ id, userId: ownerId, parentId, name, materializedPath, depth });
  }

  if (rows.length > 0) await db.insert(folders).values(rows);

  const sourceFiles = await loadFilesIn([...mirror.keys()]);
  if (sourceFiles.length > MAX_SUBTREE_FILES) {
    return apiError(
      `That's more than ${MAX_SUBTREE_FILES} files in one paste. Paste it in smaller pieces.`,
      400,
      { code: "PASTE_TOO_MANY_FILES", limit: MAX_SUBTREE_FILES }
    );
  }

  for (const root of roots) {
    await logActivity(user, "copy", {
      resourceType: "folder",
      resourceId: root.source.id,
      metadata: { via: "paste", destination: destinationId, newId: mirror.get(root.source.id)?.id },
      ip,
    });
  }

  return apiSuccess({
    folderMap: Object.fromEntries([...mirror].map(([oldId, m]) => [oldId, m.id])),
    /** Every file inside the copied subtrees, already told which new folder it belongs to. */
    files: sourceFiles
      .filter((f) => f.folderId && mirror.has(f.folderId))
      .map((f) => ({
        id: f.id,
        targetFolderId: mirror.get(f.folderId as string)!.id,
        name: f.name,
        sizeBytes: f.sizeBytes,
      })),
    created: rows.length,
    moved: 0,
    skipped,
    callerId: userId,
  });
}

/** At most this many R2 copies in flight at once inside one chunk. */
const COPY_CONCURRENCY = 4;

type PasteFileFailure = "missing" | "denied" | "unavailable" | "oversized" | "failed";

type PreparedFile = {
  item: z.infer<typeof filesSchema>["items"][number];
  file: NonNullable<Awaited<ReturnType<typeof resolveFileAccess>>>["file"];
  targetFolderId: string | null;
};

type ResolvedFile =
  | { ok: true; prepared: PreparedFile }
  | { ok: false; id: string; reason: PasteFileFailure; message: string };

/**
 * Do one bounded chunk of the per-file work.
 *
 * Everything that can refuse does so before anything is written: access, destination,
 * size and quota are all settled for the whole chunk first, so a chunk either starts or
 * it doesn't. Within the chunk each file is independent — one failure is reported for
 * that file and the rest still land, because the alternative (abandoning 19 good copies
 * because the 20th lost its object) is worse for the user and identical for the data.
 */
async function handleFiles(
  user: SessionUser,
  body: z.infer<typeof filesSchema>,
  request: NextRequest
) {
  const ip = getClientIp(request);

  const resolved = await mapLimit<(typeof body.items)[number], ResolvedFile>(
    body.items,
    RESOLVE_CONCURRENCY,
    async (item) => {
      const access = await resolveFileAccess(user, item.id);
      if (!access?.canView) {
        return { ok: false, id: item.id, reason: "missing", message: "File no longer exists." };
      }
      const file = access.file;

      if (body.mode === "cut" && !access.canEdit) {
        return { ok: false, id: item.id, reason: "denied", message: fileRefusal(access, "edit") };
      }
      // A note has no R2 object at all; anything else needs one that is actually there.
      if (!file.isNote && !(COPYABLE_STATUSES as readonly string[]).includes(file.status)) {
        return {
          ok: false,
          id: item.id,
          reason: "unavailable",
          message: "That file's contents were never finished uploading.",
        };
      }
      if (body.mode === "copy" && file.sizeBytes > MAX_SINGLE_PART_COPY_BYTES) {
        return {
          ok: false,
          id: item.id,
          reason: "oversized",
          message: "That file is too large to copy in one piece.",
        };
      }

      // The same rule a drag-move obeys: the copy lands in the file owner's tree and
      // inside the same sharing domain, or it does not land at all.
      const dest = await resolveWritableDestination(user, item.targetFolderId, {
        fileOwnerId: file.userId,
        domainOwnerId: await fileDomainOwnerId(file),
      });
      if (!dest.ok) return { ok: false, id: item.id, reason: "denied", message: dest.message };

      return { ok: true, prepared: { item, file, targetFolderId: dest.folderId } };
    }
  );

  const results: Array<{
    id: string;
    ok: boolean;
    newId?: string;
    name?: string;
    reason?: PasteFileFailure;
    message?: string;
  }> = [];
  const prepared: PreparedFile[] = [];

  for (const entry of resolved) {
    if (entry.ok) prepared.push(entry.prepared);
    else results.push({ id: entry.id, ok: false, reason: entry.reason, message: entry.message });
  }

  if (prepared.length === 0) {
    return apiSuccess({ results, copied: 0, moved: 0, failed: results.length, bytes: 0 });
  }

  /* ── names, resolved against the destination as it is right now ── */

  // The client picked these names when the conflict dialog opened. Between then and now
  // another tab may have created one of them, so the browser's answer is a request, not a
  // decision: the server has the last word on what a file ends up called.
  type Namespace = { byName: Map<string, string>; taken: Set<string> };
  const namespaces = new Map<string, Namespace>();

  async function namespaceFor(ownerId: string, folderId: string | null): Promise<Namespace> {
    const key = `${ownerId}|${folderId ?? "root"}`;
    const cached = namespaces.get(key);
    if (cached) return cached;

    const rows = await db
      .select({ id: files.id, name: files.name })
      .from(files)
      .where(
        and(
          eq(files.userId, ownerId),
          folderId ? eq(files.folderId, folderId) : isNull(files.folderId),
          isNull(files.deletedAt)
        )
      );

    const namespace: Namespace = {
      byName: new Map(rows.map((row) => [row.name, row.id])),
      taken: new Set(rows.map((row) => row.name)),
    };
    namespaces.set(key, namespace);
    return namespace;
  }

  type Work = PreparedFile & { name: string; displaceId: string | null };
  const work: Work[] = [];

  for (const p of prepared) {
    const namespace = await namespaceFor(p.file.userId, p.targetFolderId);

    // A cut into the folder the file is already in moves nothing; it must also not be
    // allowed to rename the file to "(2)" by colliding with itself.
    if (body.mode === "cut" && p.file.folderId === p.targetFolderId) {
      results.push({ id: p.item.id, ok: true, newId: p.file.id, name: p.file.name });
      continue;
    }

    let name = p.item.name;
    let displaceId: string | null = null;

    if (namespace.taken.has(name)) {
      const existingId = namespace.byName.get(name);
      if (p.item.replace && existingId && existingId !== p.file.id) {
        displaceId = existingId;
      } else {
        name = nextAvailableName(name, namespace.taken);
      }
    }
    namespace.taken.add(name);
    work.push({ ...p, name, displaceId });
  }

  /* ── quota, once for the whole chunk ── */

  if (body.mode === "copy") {
    const perOwner = new Map<string, number>();
    for (const w of work) {
      perOwner.set(w.file.userId, (perOwner.get(w.file.userId) ?? 0) + w.file.sizeBytes);
    }
    for (const [ownerId, bytes] of perOwner) {
      const verdict = await quotaVerdict(ownerId, bytes);
      if (verdict && !verdict.ok) {
        return apiError("Not enough storage space to finish this paste.", 413, {
          code: "QUOTA_EXCEEDED",
          requiredBytes: verdict.requiredBytes,
          remainingBytes: verdict.remainingBytes,
          quotaBytes: verdict.quotaBytes,
        });
      }
    }
  }

  /* ── the writes ── */

  const owners = new Set(work.map((w) => w.file.userId));

  /** Recount storage, drop the caches the new rows invalidate, and leave an audit trail. */
  async function settle(action: "copy" | "move", count: number, bytes: number): Promise<void> {
    for (const ownerId of owners) {
      await recalculateUsedBytes(ownerId);
      cacheDelPattern(`search:${ownerId}:*`).catch(() => {});
      cacheDelPattern(`files:${ownerId}:*`).catch(() => {});
    }
    // One entry per chunk, not per file: a 2000-file paste should not bury every other
    // thing the account did today under 2000 near-identical rows.
    await logActivity(user, action, {
      resourceType: "file",
      metadata: { via: "paste", count, bytes, sourceIds: work.map((w) => w.item.id) },
      ip,
    });
  }

  if (body.mode === "cut") {
    let moved = 0;
    for (const w of work) {
      try {
        await db
          .update(files)
          .set({ folderId: w.targetFolderId, name: w.name, updatedAt: new Date() })
          .where(eq(files.id, w.file.id));
        // Displace only once the move has landed: trashing the destination's file first
        // and then failing would leave the user with neither copy.
        if (w.displaceId) {
          await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, w.displaceId));
        }
        results.push({ id: w.item.id, ok: true, newId: w.file.id, name: w.name });
        moved++;
      } catch {
        results.push({
          id: w.item.id,
          ok: false,
          reason: "failed",
          message: "That file could not be moved.",
        });
      }
    }
    if (moved > 0) await settle("move", moved, 0);
    return apiSuccess({
      results,
      copied: 0,
      moved,
      failed: results.filter((r) => !r.ok).length,
      bytes: 0,
    });
  }

  /* ── copy ── */

  type CopyOutcome =
    | { id: string; ok: true; newId: string; name: string; bytes: number }
    | { id: string; ok: false; reason: PasteFileFailure; message: string };

  const outcomes = await mapLimit<Work, CopyOutcome>(work, COPY_CONCURRENCY, async (w) => {
    const file = w.file;
    const newId = crypto.randomUUID();
    const now = new Date();
    /** Objects this copy created, to be removed if the row never lands. */
    const objects: string[] = [];
    let rowInserted = false;

    try {
      let r2Key: string;
      if (file.isNote) {
        // A note's key is synthetic — there is no object behind it. The old code called
        // `copyR2Object` here regardless, which 500'd and left an orphan row behind.
        r2Key = `notes/${file.userId}/${crypto.randomUUID()}`;
      } else {
        r2Key = buildR2Key(file.userId, newId, w.name);
        await copyR2Object(file.r2Key, r2Key);
        objects.push(r2Key);
      }

      // Thumbnails are keyed by file id, so the copy gets its own instead of pointing at
      // the source's: permanently deleting the original would otherwise blank the copy.
      let thumbnailKey: string | null = null;
      if (file.thumbnailKey) {
        const candidate = file.thumbnailKey.split(file.id).join(newId);
        if (candidate !== file.thumbnailKey) {
          try {
            await copyR2Object(file.thumbnailKey, candidate);
            objects.push(candidate);
            thumbnailKey = candidate;
          } catch {
            // A missing thumbnail is a placeholder tile, not a failed paste.
          }
        }
      }

      await db.insert(files).values({
        id: newId,
        userId: file.userId,
        folderId: w.targetFolderId,
        name: w.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        r2Key,
        // Copying does not verify anything the source had not verified, so the status is
        // carried over rather than upgraded to `ready`.
        status: file.isNote ? "ready" : file.status,
        checksumSha256: file.checksumSha256,
        completedAt: now,
        verifiedAt: file.isNote || file.verifiedAt ? now : null,
        isNote: file.isNote,
        thumbnailKey,
        // Keeps the copy searchable immediately — the FTS vector is generated from this.
        contentText: file.contentText,
        encrypted: file.encrypted,
        encryptionMeta: file.encryptionMeta,
      });
      rowInserted = true;

      // Note bodies and PDF annotations live in their own table. Without this a copied
      // note opened empty and a copied PDF lost every highlight.
      const [content] = await db
        .select({
          contentJson: fileContents.contentJson,
          annotationsJson: fileContents.annotationsJson,
        })
        .from(fileContents)
        .where(eq(fileContents.fileId, file.id))
        .limit(1);
      if (content) {
        await db.insert(fileContents).values({
          fileId: newId,
          contentJson: content.contentJson,
          annotationsJson: content.annotationsJson,
        });
      }

      if (w.displaceId) {
        await db.update(files).set({ deletedAt: now }).where(eq(files.id, w.displaceId));
      }

      return { id: w.item.id, ok: true, newId, name: w.name, bytes: file.sizeBytes };
    } catch {
      // Roll the whole item back. A row without its object is a file that downloads as an
      // error; an object without its row is billed storage nobody can ever reach.
      if (rowInserted) {
        try {
          await db.delete(files).where(eq(files.id, newId));
        } catch {
          // Leave it: `status` still describes a file the UI will not offer.
        }
      }
      for (const key of objects) {
        await deleteR2Object(key).catch(() => {});
      }
      return {
        id: w.item.id,
        ok: false,
        reason: "failed",
        message: "That file could not be copied.",
      };
    }
  });

  let copied = 0;
  let bytes = 0;
  for (const outcome of outcomes) {
    if (outcome.ok) {
      copied++;
      bytes += outcome.bytes;
      results.push({ id: outcome.id, ok: true, newId: outcome.newId, name: outcome.name });
    } else {
      results.push({
        id: outcome.id,
        ok: false,
        reason: outcome.reason,
        message: outcome.message,
      });
    }
  }

  if (copied > 0) await settle("copy", copied, bytes);

  return apiSuccess({
    results,
    copied,
    moved: 0,
    failed: results.filter((r) => !r.ok).length,
    bytes,
  });
}

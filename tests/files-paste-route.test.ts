/**
 * `POST /api/files/paste` — gates and the read-only `plan` operation.
 *
 * `plan` is the half of the paste flow worth pinning down in tests: it is the only part
 * that decides *whether* a paste may happen, and every later request trusts its answer.
 * The `folders` and `files` operations are covered indirectly — they take their inputs
 * from a plan — while the pure planning arithmetic lives in `paste-plan.test.ts`.
 *
 * The database is a hand-rolled chainable stub, so each test declares the rows its
 * request will read in the order the route reads them. That ordering is part of what is
 * asserted: a plan that starts querying in a different order is a plan whose costs have
 * changed.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";

const selectQueue = vi.hoisted(() => ({ rows: [] as unknown[][] }));
const dbCalls = vi.hoisted(() => ({ selects: 0, updates: 0, inserts: 0, executes: 0 }));
const executeRows = vi.hoisted(() => ({ rows: [] as unknown[] }));

vi.mock("@/shared/infrastructure/db", () => {
  type Q = {
    set: (...a: unknown[]) => Q;
    where: (...a: unknown[]) => Q;
    from: (...a: unknown[]) => Q;
    values: (...a: unknown[]) => Q;
    orderBy: (...a: unknown[]) => Q;
    limit: (...a: unknown[]) => Promise<unknown[]>;
    returning: (...a: unknown[]) => Promise<unknown[]>;
    then: (r: (v: unknown[]) => unknown, j?: (e: unknown) => unknown) => Promise<unknown>;
  };

  function q(result: () => unknown[]): Q {
    const api: Q = {
      set: () => api,
      where: () => api,
      from: () => api,
      values: () => api,
      orderBy: () => api,
      limit: async () => result(),
      returning: async () => result(),
      then: (r, j) => Promise.resolve(result()).then(r, j),
    };
    return api;
  }

  const next = () => {
    dbCalls.selects++;
    return selectQueue.rows.shift() ?? [];
  };

  return {
    db: {
      select: () => q(next),
      update: () => {
        dbCalls.updates++;
        return q(() => []);
      },
      insert: () => {
        dbCalls.inserts++;
        return q(() => []);
      },
      delete: () => q(() => []),
      execute: async () => {
        dbCalls.executes++;
        return executeRows.rows;
      },
    },
    recalculateUsedBytes: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/shared/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/security")>();
  return { ...actual, validateCsrf: vi.fn(), checkUserApiRateLimit: vi.fn() };
});

vi.mock("@/shared/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/session")>();
  return { ...actual, requireAuth: vi.fn(), getClientIp: vi.fn(() => "127.0.0.1") };
});

// `importOriginal` on purpose: the refusal-message helpers and `getEffectiveUserId` are
// pure and are part of what the route's responses are asserted against. Only the four
// capability resolvers — the ones that would hit the database — are replaced.
vi.mock("@/shared/lib/auth/permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/auth/permissions")>();
  return {
    ...actual,
    resolveFileAccess: vi.fn(),
    resolveFolderAccess: vi.fn(),
    resolveWritableDestination: vi.fn(),
    fileDomainOwnerId: vi.fn(),
  };
});

vi.mock("@/shared/lib/auth/audit", () => ({ logActivity: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@files/infrastructure/storage/r2", () => ({
  buildR2Key: vi.fn((userId: string, fileId: string) => `users/${userId}/${fileId}`),
  copyR2Object: vi.fn().mockResolvedValue(undefined),
  deleteR2Object: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/infrastructure/cache/redis", () => ({
  cacheDelPattern: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/shared/lib/settings/admin-settings", () => ({
  getAdminSettings: vi.fn().mockResolvedValue({ rateLimitPerMinute: 1000 }),
}));

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const FILE_A = "33333333-3333-4333-8333-333333333333";
const FILE_B = "44444444-4444-4444-8444-444444444444";
const FOLDER_A = "55555555-5555-4555-8555-555555555555";
const FOLDER_DEST = "66666666-6666-4666-8666-666666666666";

const { validateCsrf, checkUserApiRateLimit } = await import("@/shared/lib/security");
const { requireAuth } = await import("@/shared/lib/auth/session");
const {
  resolveFileAccess,
  resolveFolderAccess,
  resolveWritableDestination,
  fileDomainOwnerId,
} = await import("@/shared/lib/auth/permissions");
const route = await import("@/app/api/files/paste/route");

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/files/paste", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A `plan` body with the boring fields filled in. */
function planBody(over: Record<string, unknown> = {}) {
  return {
    op: "plan",
    mode: "copy",
    destinationFolderId: null,
    entries: [{ kind: "file", id: FILE_A }],
    ...over,
  };
}

function fileAccess(over: Record<string, unknown> = {}) {
  const { canView = true, canEdit = true, ...file } = over;
  return {
    canView,
    canEdit,
    canTrash: canEdit,
    canPurge: canEdit,
    isOwner: true,
    role: "owner",
    file: {
      id: FILE_A,
      userId: OWNER,
      folderId: null,
      name: "report.pdf",
      sizeBytes: 100,
      isNote: false,
      status: "ready",
      deletedAt: null,
      ...file,
    },
  } as never;
}

function folderAccess(over: Record<string, unknown> = {}) {
  const { canView = true, canEdit = true, isOwner = true, isShareRoot = false, ...folder } = over;
  return {
    canView,
    canEdit,
    canManageMembers: isOwner,
    canTrashFolder: isOwner,
    canPurge: isOwner,
    canOwnerOnlyFlags: isOwner,
    role: isOwner ? "owner" : canEdit ? "edit" : "view",
    isOwner,
    viaMembership: !isOwner,
    masterOverride: false,
    shareRootId: null,
    isShareRoot,
    folder: {
      id: FOLDER_A,
      userId: OWNER,
      parentId: null,
      name: "Docs",
      materializedPath: "/Docs/",
      depth: 0,
      deletedAt: null,
      ...folder,
    },
  } as never;
}

async function body(res: Response) {
  return (await res.json()) as Record<string, unknown> & { data?: Record<string, unknown> };
}

beforeEach(() => {
  selectQueue.rows = [];
  executeRows.rows = [];
  dbCalls.selects = 0;
  dbCalls.updates = 0;
  dbCalls.inserts = 0;
  dbCalls.executes = 0;

  vi.mocked(validateCsrf).mockReset().mockResolvedValue(true);
  vi.mocked(checkUserApiRateLimit).mockReset().mockResolvedValue({ allowed: true } as never);
  vi.mocked(requireAuth)
    .mockReset()
    .mockResolvedValue({
      id: OWNER,
      effectiveUserId: OWNER,
      role: "user",
      isImpersonating: false,
      sessionId: "s",
    } as never);
  vi.mocked(resolveFileAccess).mockReset().mockResolvedValue(null);
  vi.mocked(resolveFolderAccess).mockReset().mockResolvedValue(null);
  vi.mocked(resolveWritableDestination).mockReset().mockResolvedValue({ ok: true } as never);
  vi.mocked(fileDomainOwnerId).mockReset().mockResolvedValue(OWNER);
});

describe("POST /api/files/paste — gates", () => {
  it("rejects a missing CSRF token before it ever looks at the session", async () => {
    vi.mocked(validateCsrf).mockResolvedValue(false);

    const res = await route.POST(req(planBody()));

    expect(res.status).toBe(403);
    // The order matters: a CSRF failure must cost nothing, not even a session lookup.
    expect(requireAuth).not.toHaveBeenCalled();
    expect(dbCalls.selects).toBe(0);
  });

  it("returns 429 when the caller is over the API rate limit", async () => {
    vi.mocked(checkUserApiRateLimit).mockResolvedValue({ allowed: false } as never);

    const res = await route.POST(req(planBody()));

    expect(res.status).toBe(429);
    expect(dbCalls.selects).toBe(0);
  });

  it("rate-limits on the effective user, so an impersonated session cannot borrow a fresh budget", async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      id: OTHER,
      effectiveUserId: OWNER,
      role: "master",
      isImpersonating: true,
      sessionId: "s",
    } as never);
    selectQueue.rows = [[], []];

    await route.POST(req(planBody()));

    expect(vi.mocked(checkUserApiRateLimit).mock.calls[0][0]).toBe(OWNER);
  });
});

describe("POST /api/files/paste — request validation", () => {
  const rejected: Array<[string, unknown]> = [
    ["an unknown operation", { op: "teleport", mode: "copy", entries: [] }],
    ["a plan with no entries", planBody({ entries: [] })],
    [
      "a plan over the 500-entry clipboard ceiling",
      planBody({
        entries: Array.from({ length: 501 }, () => ({ kind: "file", id: FILE_A })),
      }),
    ],
    ["a plan with no mode", { op: "plan", destinationFolderId: null, entries: [{ kind: "file", id: FILE_A }] }],
    ["a plan entry whose id is not a uuid", planBody({ entries: [{ kind: "file", id: "nope" }] })],
    [
      "a files chunk of 21 items",
      {
        op: "files",
        mode: "copy",
        items: Array.from({ length: 21 }, () => ({
          id: FILE_A,
          targetFolderId: null,
          name: "a.txt",
        })),
      },
    ],
    [
      "a folders batch over 100 items",
      {
        op: "folders",
        mode: "copy",
        destinationFolderId: null,
        items: Array.from({ length: 101 }, () => ({ id: FOLDER_A, name: "Docs" })),
      },
    ],
    [
      "a files item with a blank name",
      { op: "files", mode: "copy", items: [{ id: FILE_A, targetFolderId: null, name: "   " }] },
    ],
  ];

  for (const [label, payload] of rejected) {
    it(`rejects ${label} with a 400 validation error`, async () => {
      const res = await route.POST(req(payload));

      expect(res.status).toBe(400);
      expect((await body(res)).code).toBe("VALIDATION_ERROR");
      expect(dbCalls.selects).toBe(0);
      expect(dbCalls.updates).toBe(0);
      expect(dbCalls.inserts).toBe(0);
    });
  }
});

describe("POST /api/files/paste — plan: destination", () => {
  it("404s when the destination folder does not resolve", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(null);

    const res = await route.POST(req(planBody({ destinationFolderId: FOLDER_DEST })));

    expect(res.status).toBe(404);
  });

  it("403s with the view-access refusal when the caller may not write to the destination", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(
      folderAccess({ id: FOLDER_DEST, canEdit: false, isOwner: false })
    );

    const res = await route.POST(req(planBody({ destinationFolderId: FOLDER_DEST })));

    expect(res.status).toBe(403);
    expect((await body(res)).error).toContain("view access");
    // Refused before any clipboard id was resolved.
    expect(resolveFileAccess).not.toHaveBeenCalled();
  });

  it("plans against the caller's own root without querying for a destination", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess());
    selectQueue.rows = [
      [{ quotaBytes: 1000, usedBytes: 200, reservedBytes: 100 }],
      [{ name: "Docs" }],
      [{ name: "report.pdf" }],
    ];

    const res = await route.POST(req(planBody()));
    const payload = await body(res);

    expect(res.status).toBe(200);
    expect(dbCalls.executes).toBe(0);
    expect(payload.data).toMatchObject({
      mode: "copy",
      destinationFolderId: null,
      destinationOwnerId: OWNER,
      items: [{ kind: "file", id: FILE_A, name: "report.pdf", sizeBytes: 100, isNote: false }],
      missing: [],
      denied: [],
      existing: { folders: ["Docs"], files: ["report.pdf"] },
      totals: { folders: 0, files: 1, bytes: 100 },
      oversized: [],
      quota: [
        {
          ownerId: OWNER,
          ok: true,
          quotaBytes: 1000,
          usedBytes: 200,
          remainingBytes: 700,
          requiredBytes: 100,
        },
      ],
      limits: { maxFilesPerChunk: 20, maxSubtreeFolders: 500, maxSubtreeFiles: 2000 },
      callerId: OWNER,
    });
  });
});

describe("POST /api/files/paste — plan: clipboard entries", () => {
  it("reports an id that no longer resolves as missing instead of failing the plan", async () => {
    vi.mocked(resolveFileAccess).mockImplementation(async (_user, id) =>
      id === FILE_A ? fileAccess() : null
    );
    selectQueue.rows = [
      [{ quotaBytes: 1000, usedBytes: 0, reservedBytes: 0 }],
      [],
      [],
    ];

    const res = await route.POST(
      req(planBody({ entries: [{ kind: "file", id: FILE_A }, { kind: "file", id: FILE_B }] }))
    );
    const payload = await body(res);

    expect(res.status).toBe(200);
    expect(payload.data).toMatchObject({ missing: [FILE_B], denied: [] });
    expect((payload.data as { items: unknown[] }).items).toHaveLength(1);
  });

  it("denies cutting a file the caller can only view, and still plans the rest", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(
      fileAccess({ canEdit: false, isOwner: false })
    );
    selectQueue.rows = [[], []];

    const res = await route.POST(req(planBody({ mode: "cut" })));
    const payload = await body(res);

    expect(res.status).toBe(200);
    expect(payload.data).toMatchObject({ mode: "cut", denied: [FILE_A], items: [] });
  });

  it("denies copying a file whose destination the caller may not write to", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess());
    vi.mocked(resolveWritableDestination).mockResolvedValue({ ok: false } as never);
    selectQueue.rows = [[], []];

    const payload = await body(await route.POST(req(planBody())));

    expect(payload.data).toMatchObject({ denied: [FILE_A], items: [], quota: [] });
  });

  it("resolves the destination rule once for a selection that shares it", async () => {
    vi.mocked(resolveFileAccess).mockImplementation(async (_user, id) =>
      fileAccess({ id, name: `${id}.txt` })
    );
    selectQueue.rows = [
      [{ quotaBytes: 10_000, usedBytes: 0, reservedBytes: 0 }],
      [],
      [],
    ];

    await route.POST(
      req(planBody({ entries: [{ kind: "file", id: FILE_A }, { kind: "file", id: FILE_B }] }))
    );

    // Two files, one owner, one destination — memoised down to a single check each.
    expect(vi.mocked(fileDomainOwnerId)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveWritableDestination)).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/files/paste — plan: quota and size ceilings", () => {
  it("reports a copy that does not fit as ok:false rather than refusing outright", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess({ sizeBytes: 500 }));
    selectQueue.rows = [
      [{ quotaBytes: 400, usedBytes: 0, reservedBytes: 0 }],
      [],
      [],
    ];

    const res = await route.POST(req(planBody()));
    const payload = await body(res);

    // 200: the browser owns the message, and the plan still carries what it needs for it.
    expect(res.status).toBe(200);
    expect(payload.data).toMatchObject({
      quota: [{ ok: false, remainingBytes: 400, requiredBytes: 500 }],
    });
  });

  it("counts reserved bytes as spent, so two pastes in flight cannot both fit", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess({ sizeBytes: 300 }));
    selectQueue.rows = [
      [{ quotaBytes: 1000, usedBytes: 500, reservedBytes: 400 }],
      [],
      [],
    ];

    const payload = await body(await route.POST(req(planBody())));

    expect(payload.data).toMatchObject({ quota: [{ ok: false, remainingBytes: 100 }] });
  });

  it("flags a file past the single-part copy ceiling and leaves it out of the quota sum", async () => {
    const huge = 6 * 1024 * 1024 * 1024;
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess({ sizeBytes: huge }));
    selectQueue.rows = [[], []];

    const payload = await body(await route.POST(req(planBody())));

    expect(payload.data).toMatchObject({
      oversized: [{ id: FILE_A, name: "report.pdf", sizeBytes: huge }],
      // Nothing left to weigh, so no owner is looked up at all.
      quota: [],
      totals: { files: 1, bytes: huge },
    });
    // Two selects: the destination's folder names and file names. No `users` row read.
    expect(dbCalls.selects).toBe(2);
  });

  it("never asks for headroom on a cut, because a move stores no new bytes", async () => {
    vi.mocked(resolveFileAccess).mockResolvedValue(fileAccess({ sizeBytes: 999_999 }));
    selectQueue.rows = [[], []];

    const payload = await body(await route.POST(req(planBody({ mode: "cut" }))));

    expect(payload.data).toMatchObject({ quota: [] });
    expect(dbCalls.selects).toBe(2);
  });
});

describe("POST /api/files/paste — plan: folder geometry", () => {
  it("refuses a folder pasted into itself", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(folderAccess({ id: FOLDER_A }));
    executeRows.rows = [{ id: FOLDER_A }];

    const res = await route.POST(
      req(
        planBody({
          destinationFolderId: FOLDER_A,
          entries: [{ kind: "folder", id: FOLDER_A }],
        })
      )
    );

    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe("PASTE_INTO_SELF");
  });

  it("refuses a folder pasted into one of its own descendants", async () => {
    vi.mocked(resolveFolderAccess).mockImplementation(async (_user, id) =>
      id === FOLDER_DEST
        ? folderAccess({
            id: FOLDER_DEST,
            parentId: FOLDER_A,
            name: "Inner",
            materializedPath: "/Docs/Inner/",
            depth: 1,
          })
        : folderAccess({ id: FOLDER_A })
    );
    // The ancestry CTE walks Inner → Docs, so Docs is on the destination's path.
    executeRows.rows = [{ id: FOLDER_DEST }, { id: FOLDER_A }];

    const res = await route.POST(
      req(
        planBody({
          destinationFolderId: FOLDER_DEST,
          entries: [{ kind: "folder", id: FOLDER_A }],
        })
      )
    );

    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe("PASTE_INTO_DESCENDANT");
  });

  it("refuses a folder from another account, whose path and quota belong elsewhere", async () => {
    vi.mocked(resolveFolderAccess).mockImplementation(async (_user, id) =>
      id === FOLDER_DEST
        ? folderAccess({ id: FOLDER_DEST, name: "Mine", materializedPath: "/Mine/" })
        : folderAccess({ id: FOLDER_A, userId: OTHER, isOwner: false })
    );
    executeRows.rows = [{ id: FOLDER_DEST }];

    const res = await route.POST(
      req(
        planBody({
          destinationFolderId: FOLDER_DEST,
          entries: [{ kind: "folder", id: FOLDER_A }],
        })
      )
    );

    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe("PASTE_CROSS_ACCOUNT");
  });

  it("denies cutting a shared root out from under its owner", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(
      folderAccess({ id: FOLDER_A, isOwner: false, isShareRoot: true })
    );
    selectQueue.rows = [[], []];

    const payload = await body(
      await route.POST(
        req(planBody({ mode: "cut", entries: [{ kind: "folder", id: FOLDER_A }] }))
      )
    );

    expect(payload.data).toMatchObject({ denied: [FOLDER_A], items: [] });
  });

  it("plans a folder copy with the subtree it drags along", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(folderAccess({ id: FOLDER_A }));
    selectQueue.rows = [
      // loadSubtreeFolders: the root plus one child
      [
        {
          id: FOLDER_A,
          userId: OWNER,
          parentId: null,
          name: "Docs",
          materializedPath: "/Docs/",
          depth: 0,
        },
        {
          id: FOLDER_DEST,
          userId: OWNER,
          parentId: FOLDER_A,
          name: "Inner",
          materializedPath: "/Docs/Inner/",
          depth: 1,
        },
      ],
      // loadFilesIn: one file inside the subtree
      [{ id: FILE_B, name: "deep.txt", sizeBytes: 250, folderId: FOLDER_DEST, userId: OWNER }],
      // quotaVerdict
      [{ quotaBytes: 10_000, usedBytes: 0, reservedBytes: 0 }],
      // loadExistingNames
      [{ name: "Docs" }],
      [],
    ];

    const payload = await body(
      await route.POST(req(planBody({ entries: [{ kind: "folder", id: FOLDER_A }] })))
    );

    expect(payload.data).toMatchObject({
      items: [{ kind: "folder", id: FOLDER_A, name: "Docs", sizeBytes: 0 }],
      totals: { folders: 2, files: 1, bytes: 250 },
      quota: [{ requiredBytes: 250, ok: true }],
      existing: { folders: ["Docs"], files: [] },
    });
  });

  it("refuses a subtree over the folder ceiling before it starts weighing files", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(folderAccess({ id: FOLDER_A }));
    selectQueue.rows = [
      Array.from({ length: 501 }, (_, i) => ({
        id: `f${i}`,
        userId: OWNER,
        parentId: null,
        name: `n${i}`,
        materializedPath: `/n${i}/`,
        depth: 0,
      })),
    ];

    const res = await route.POST(
      req(planBody({ entries: [{ kind: "folder", id: FOLDER_A }] }))
    );
    const payload = await body(res);

    expect(res.status).toBe(400);
    expect(payload.code).toBe("PASTE_TOO_MANY_FOLDERS");
    expect(payload.limit).toBe(500);
    // Bailed straight after the subtree query — no file scan, no quota read.
    expect(dbCalls.selects).toBe(1);
  });

  it("refuses a subtree over the file ceiling", async () => {
    vi.mocked(resolveFolderAccess).mockResolvedValue(folderAccess({ id: FOLDER_A }));
    selectQueue.rows = [
      [
        {
          id: FOLDER_A,
          userId: OWNER,
          parentId: null,
          name: "Docs",
          materializedPath: "/Docs/",
          depth: 0,
        },
      ],
      Array.from({ length: 2001 }, (_, i) => ({
        id: `x${i}`,
        name: `x${i}.txt`,
        sizeBytes: 1,
        folderId: FOLDER_A,
        userId: OWNER,
      })),
    ];

    const res = await route.POST(
      req(planBody({ entries: [{ kind: "folder", id: FOLDER_A }] }))
    );
    const payload = await body(res);

    expect(res.status).toBe(400);
    expect(payload.code).toBe("PASTE_TOO_MANY_FILES");
    expect(payload.limit).toBe(2000);
  });
});

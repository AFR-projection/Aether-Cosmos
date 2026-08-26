import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "stream";
import sharp from "sharp";
import { EDIT_MAX_DIMENSION, EDIT_SOURCE_MAX_BYTES } from "@/lib/files/edit-limits";

/**
 * Bounds and guarantees on the server-side image editor and the media trimmer.
 *
 * `POST /api/files/edit` took `width`/`height`/`rotate`/`crop` as bare numbers and
 * handed them to sharp. `resize` there runs with `fit: "inside"` and no
 * `withoutEnlargement`, so it enlarges: a ~200-byte body asking for `100000 x 100000`
 * is a request for a 10-gigapixel canvas in the shared Node process. The source object
 * was also read whole with `transformToByteArray()`, with no ceiling and while trusting
 * the uploader-declared size in the row.
 *
 * `PUT` (trim) had its own problem: no media-type check and no `end > start`, and the
 * worker writes ffmpeg's output back over the original — so a request with an inverted
 * window destroyed the caller's file, with no version kept.
 *
 * The later round of fixes is pinned here too, because each one is invisible until it
 * regresses: the pipeline auto-orients before cropping, re-encodes to the file's own
 * format instead of always JPEG, refuses animated sources rather than flattening them
 * to frame one, keeps `users.usedBytes` in step with the new object size, enforces the
 * quota, and only reports `queued` when there is a queue to accept the job.
 */

const NEW_FILE_ID = "9b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

const store = vi.hoisted(() => ({
  file: null as Record<string, unknown> | null,
  canEdit: true,
  /** Bytes R2 actually hands back, whatever the row claims. */
  body: null as unknown,
  r2Calls: 0,
  put: [] as { key: string; size: number; contentType: string; body: Buffer }[],
  snapshots: 0,
  jobs: [] as { type: string; data: Record<string, unknown> }[],
  updates: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  recalculated: [] as string[],
  activity: [] as { action: string; metadata: unknown }[],
  /** `null` stands for an account row that no longer exists. */
  owner: null as { quotaBytes: number; usedBytes: number; reservedBytes: number } | null,
  destination: { ok: true, folderId: null } as Record<string, unknown>,
  /** Whether Redis is reachable, which is what makes `queued: true` true. */
  queueUp: true,
}));

vi.mock("@/lib/security", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security")>();
  return { ...actual, validateCsrf: vi.fn().mockResolvedValue(true) };
});

vi.mock("@/lib/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/session")>();
  return {
    ...actual,
    requireAuth: vi.fn().mockResolvedValue({ id: "user-1", role: "user" }),
    getClientIp: vi.fn(() => "127.0.0.1"),
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  getAccessibleFile: vi.fn(async () =>
    store.file ? { canView: true, canEdit: store.canEdit, file: store.file } : null
  ),
  getEffectiveUserId: vi.fn(() => "user-1"),
  fileRefusal: vi.fn(() => "You don't have permission to edit this file"),
  fileDomainOwnerId: vi.fn(async () => null),
  resolveWritableDestination: vi.fn(async () => store.destination),
}));

vi.mock("@/lib/storage/r2", () => ({
  objectExists: vi.fn(async () => true),
  downloadFromR2Stream: vi.fn(async () => {
    store.r2Calls++;
    return { body: store.body };
  }),
  putR2Object: vi.fn(async (key: string, body: Buffer, contentType: string) => {
    store.put.push({ key, size: body.length, contentType, body });
  }),
  buildR2Key: vi.fn((userId: string, fileId: string) => `users/${userId}/objects/${fileId}`),
}));

vi.mock("@/lib/files/versions", () => ({
  snapshotFileVersion: vi.fn(async () => {
    store.snapshots++;
    return { previousVersion: 1, newVersion: 2 };
  }),
}));

vi.mock("@/lib/queue", () => ({
  getQueue: vi.fn(() => (store.queueUp ? ({} as unknown) : null)),
  enqueueJob: vi.fn(async (type: string, data: Record<string, unknown>) => {
    if (!store.queueUp) return false;
    store.jobs.push({ type, data });
    return true;
  }),
}));

vi.mock("@/lib/auth/audit", () => ({
  logActivity: vi.fn(async (_user: unknown, action: string, options?: { metadata?: unknown }) => {
    store.activity.push({ action, metadata: options?.metadata });
  }),
}));

vi.mock("@/lib/db", () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (store.owner ? [store.owner] : []),
  };
  const updateChain = {
    set: (values: Record<string, unknown>) => {
      store.updates.push(values);
      return updateChain;
    },
    where: async () => undefined,
  };
  const insertChain = {
    values: (values: Record<string, unknown>) => {
      store.inserts.push(values);
      return insertChain;
    },
    returning: async () => [{ id: NEW_FILE_ID, ...store.inserts.at(-1) }],
  };
  return {
    db: {
      select: () => selectChain,
      update: () => updateChain,
      insert: () => insertChain,
    },
    recalculateUsedBytes: vi.fn(async (userId: string) => {
      store.recalculated.push(userId);
    }),
  };
});

vi.mock("@/lib/db/schema", async (importOriginal) => importOriginal());

const FILE_ID = "6f1a1b1e-1c2d-4e3f-8a4b-5c6d7e8f9a01";

/** A real 2-frame GIF, so the animated refusal is decided by libvips and not a stub. */
const ANIMATED_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAP///wAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

/** A real PNG, so sharp is exercised for real rather than mocked. */
async function png(width = 64, height = 64) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .png()
    .toBuffer();
}

async function jpeg(width = 64, height = 64) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .jpeg()
    .toBuffer();
}

/**
 * A 2×2 PNG of four unmistakable pixels — red, green over blue, white.
 *
 * Small enough to assert whole, which is the only way to tell a mirror from a rotation, or
 * `rotate().flop()` from `flop().rotate()`. PNG so the round trip is lossless and the
 * comparison can be exact.
 */
async function quadPng() {
  return sharp(Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]), {
    raw: { width: 2, height: 2, channels: 3 },
  })
    .png()
    .toBuffer();
}

/** Over 256 distinct colours, so palette quantisation shows up as lost colours. */
async function gradientPng(size = 64) {
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const at = (y * size + x) * 3;
      raw[at] = (x * 4) % 256;
      raw[at + 1] = (y * 4) % 256;
      raw[at + 2] = (x * 2 + y * 3) % 256;
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer();
}

/** Every pixel of an encoded image, row-major, as `"r,g,b"` — comparable with `toEqual`. */
async function pixels(buffer: Buffer): Promise<string[]> {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const out: string[] = [];
  for (let at = 0; at + 2 < data.length; at += info.channels) {
    out.push(`${data[at]},${data[at + 1]},${data[at + 2]}`);
  }
  return out;
}

const RED = "255,0,0";
const GREEN = "0,255,0";
const BLUE = "0,0,255";
const WHITE = "255,255,255";

async function seedImage(overrides: Record<string, unknown> = {}, bytes?: Buffer) {
  const buffer = bytes ?? (await png());
  store.file = {
    id: FILE_ID,
    userId: "user-1",
    folderId: null,
    name: "photo.png",
    mimeType: "image/png",
    r2Key: `files/${FILE_ID}`,
    sizeBytes: buffer.length,
    version: 1,
    encrypted: false,
    checksumSha256: null,
    ...overrides,
  };
  store.body = Readable.from([buffer]);
  return buffer;
}

function seedMedia(overrides: Record<string, unknown> = {}) {
  store.file = {
    id: FILE_ID,
    userId: "user-1",
    folderId: null,
    name: "clip.mp4",
    mimeType: "video/mp4",
    r2Key: `files/${FILE_ID}`,
    sizeBytes: 1024,
    version: 1,
    encrypted: false,
    checksumSha256: null,
    ...overrides,
  };
}

async function edit(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/files/edit/route");
  return POST(
    new NextRequest("http://localhost/api/files/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

async function trim(body: Record<string, unknown>) {
  const { PUT } = await import("@/app/api/files/edit/route");
  return PUT(
    new NextRequest("http://localhost/api/files/edit", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  store.file = null;
  store.canEdit = true;
  store.body = null;
  store.r2Calls = 0;
  store.put = [];
  store.snapshots = 0;
  store.jobs = [];
  store.updates = [];
  store.inserts = [];
  store.recalculated = [];
  store.activity = [];
  store.owner = { quotaBytes: 10 * 1024 * 1024 * 1024, usedBytes: 0, reservedBytes: 0 };
  store.destination = { ok: true, folderId: null };
  store.queueUp = true;
  vi.clearAllMocks();
});

describe("POST /api/files/edit — output size", () => {
  it("resizes within the ceiling", async () => {
    await seedImage();
    const response = await edit({ fileId: FILE_ID, action: "resize", width: 32, height: 32 });

    expect(response.status).toBe(200);
    expect(store.put).toHaveLength(1);
    expect(store.updates[0]).toMatchObject({ sizeBytes: store.put[0].size });
  });

  it("refuses a 10-gigapixel resize before reading anything", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: 100000,
      height: 100000,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "VALIDATION_ERROR" });
    // Nothing was fetched, nothing was decoded, nothing was written.
    expect(store.r2Calls).toBe(0);
    expect(store.put).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("refuses an area over the ceiling even when each side is allowed", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: EDIT_MAX_DIMENSION,
      height: EDIT_MAX_DIMENSION,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_OUTPUT_TOO_LARGE" });
    expect(store.r2Calls).toBe(0);
  });

  it("refuses a single side past the dimension ceiling", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: EDIT_MAX_DIMENSION + 1,
    });
    expect(response.status).toBe(400);
    expect(store.r2Calls).toBe(0);
  });

  it("refuses a crop area past the ceiling", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      crop: { x: 0, y: 0, width: EDIT_MAX_DIMENSION, height: EDIT_MAX_DIMENSION },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_OUTPUT_TOO_LARGE" });
    expect(store.r2Calls).toBe(0);
  });

  it("refuses negative and fractional geometry", async () => {
    await seedImage();
    for (const body of [
      { fileId: FILE_ID, action: "resize", width: -1 },
      { fileId: FILE_ID, action: "resize", width: 0 },
      { fileId: FILE_ID, action: "resize", width: 10.5 },
      { fileId: FILE_ID, action: "crop", crop: { x: -5, y: 0, width: 10, height: 10 } },
      { fileId: FILE_ID, action: "rotate", rotate: 100000 },
      { fileId: FILE_ID, action: "compress", quality: 0 },
      { fileId: FILE_ID, action: "compress", quality: 101 },
    ]) {
      const response = await edit(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(store.r2Calls).toBe(0);
  });

  it("turns a crop outside the image into a 400, not a 500", async () => {
    await seedImage(); // 64x64
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      crop: { x: 60, y: 60, width: 100, height: 100 },
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_FAILED" });
    expect(store.put).toEqual([]);
  });
});

describe("POST /api/files/edit — source size", () => {
  it("refuses an over-sized file before touching R2", async () => {
    await seedImage({ sizeBytes: EDIT_SOURCE_MAX_BYTES + 1 });
    const response = await edit({ fileId: FILE_ID, action: "compress" });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_SOURCE_TOO_LARGE" });
    expect(store.r2Calls).toBe(0);
    expect(store.snapshots).toBe(0);
  });

  it("counts the bytes it reads instead of trusting the row", async () => {
    // The row says 1 KB; R2 hands back far more. Declared sizes are
    // uploader-supplied on the legacy presign path.
    await seedImage({ sizeBytes: 1024 });
    store.body = Readable.from(
      Array.from({ length: 3 }, () => Buffer.alloc(32 * 1024 * 1024, 7))
    );

    const response = await edit({ fileId: FILE_ID, action: "compress" });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "EDIT_SOURCE_TOO_LARGE",
      maxBytes: EDIT_SOURCE_MAX_BYTES,
    });
    expect(store.put).toEqual([]);
    // The snapshot is taken after the bytes are in hand, so a refusal here leaves no
    // version row pointing at an edit that never happened.
    expect(store.snapshots).toBe(0);
  });
});

describe("POST /api/files/edit — access and type", () => {
  it("refuses SVG rather than running the rasterizer over it", async () => {
    await seedImage({ mimeType: "image/svg+xml", name: "a.svg" });
    const response = await edit({ fileId: FILE_ID, action: "compress" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_MIME_REFUSED" });
    expect(store.r2Calls).toBe(0);
  });

  it("refuses a non-image", async () => {
    await seedImage({ mimeType: "application/pdf", name: "a.pdf" });
    expect((await edit({ fileId: FILE_ID, action: "compress" })).status).toBe(400);
    expect(store.r2Calls).toBe(0);
  });

  it("refuses an end-to-end encrypted file, which is ciphertext to sharp", async () => {
    await seedImage({ encrypted: true });
    const response = await edit({ fileId: FILE_ID, action: "compress" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_ENCRYPTED_REFUSED" });
    expect(store.r2Calls).toBe(0);
  });

  it("404s a file the caller cannot see", async () => {
    store.file = null;
    expect((await edit({ fileId: FILE_ID, action: "compress" })).status).toBe(404);
  });

  it("403s a viewer who cannot edit", async () => {
    await seedImage();
    store.canEdit = false;
    expect((await edit({ fileId: FILE_ID, action: "compress" })).status).toBe(403);
    expect(store.r2Calls).toBe(0);
  });
});

describe("POST /api/files/edit — animated sources", () => {
  it("refuses an animated GIF instead of returning frame one", async () => {
    await seedImage({ mimeType: "image/gif", name: "loop.gif" }, ANIMATED_GIF);
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 70 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_ANIMATED_REFUSED" });
    expect(store.put).toEqual([]);
    // Refused before the snapshot, so a rejected edit leaves nothing behind.
    expect(store.snapshots).toBe(0);
  });

  it("still edits a single-frame image of the same family", async () => {
    const still = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp()
      .toBuffer();
    await seedImage({ mimeType: "image/webp", name: "still.webp" }, still);
    expect((await edit({ fileId: FILE_ID, action: "rotate", rotate: 90 })).status).toBe(200);
  });

  it("turns an undecodable buffer into a 400", async () => {
    await seedImage({}, Buffer.from("this is not an image at all", "utf8"));
    const response = await edit({ fileId: FILE_ID, action: "compress" });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "EDIT_FAILED" });
    expect(store.put).toEqual([]);
  });
});

describe("POST /api/files/edit — format is preserved", () => {
  it("re-compresses a PNG as a PNG, not as JPEG under a .png name", async () => {
    await seedImage();
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 60 });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { mimeType: "image/png" } });
    expect(store.put[0].contentType).toBe("image/png");
    expect((await sharp(store.put[0].body).metadata()).format).toBe("png");
    // Nothing was renamed, because nothing about the format changed.
    expect(store.updates[0]).not.toHaveProperty("name");
    expect(store.updates[0]).not.toHaveProperty("mimeType");
  });

  it("re-compresses a JPEG as a JPEG", async () => {
    await seedImage({ mimeType: "image/jpeg", name: "photo.jpg" }, await jpeg());
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 40 });

    expect(response.status).toBe(200);
    expect(store.put[0].contentType).toBe("image/jpeg");
    expect((await sharp(store.put[0].body).metadata()).format).toBe("jpeg");
  });

  it("renames when the format genuinely has to change", async () => {
    // sharp cannot write TIFF back through this route's encoder set, so the result is
    // JPEG — and a `.tiff` name holding JPEG bytes breaks every later read.
    const tiff = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 5, g: 5, b: 5 } },
    })
      .tiff()
      .toBuffer();
    await seedImage({ mimeType: "image/tiff", name: "scan.tiff" }, tiff);
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 70 });

    expect(response.status).toBe(200);
    expect(store.updates[0]).toMatchObject({ mimeType: "image/jpeg", name: "scan.jpg" });
    expect(store.put[0].contentType).toBe("image/jpeg");
  });
});

describe("POST /api/files/edit — flips", () => {
  it("mirrors left-to-right and leaves the frame the size it was", async () => {
    await seedImage({}, await quadPng());
    const response = await edit({ fileId: FILE_ID, action: "flip", flipHorizontal: true });

    expect(response.status).toBe(200);
    // R G   →   G R
    // B W       W B
    await expect(pixels(store.put[0].body)).resolves.toEqual([GREEN, RED, WHITE, BLUE]);
    const meta = await sharp(store.put[0].body).metadata();
    expect([meta.width, meta.height]).toEqual([2, 2]);
    // A flip alone is not a re-encode, so the format and the name are left alone.
    expect(meta.format).toBe("png");
    expect(store.updates[0]).not.toHaveProperty("name");
  });

  it("mirrors top-to-bottom", async () => {
    await seedImage({}, await quadPng());
    const response = await edit({ fileId: FILE_ID, action: "flip", flipVertical: true });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([BLUE, WHITE, RED, GREEN]);
  });

  it("applies both mirrors, which together are a half turn", async () => {
    await seedImage({}, await quadPng());
    const response = await edit({
      fileId: FILE_ID,
      action: "flip",
      flipHorizontal: true,
      flipVertical: true,
    });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([WHITE, BLUE, GREEN, RED]);
  });

  it("mirrors AFTER rotating, because that is the order the panel previews and crops in", async () => {
    await seedImage({}, await quadPng());
    const response = await edit({
      fileId: FILE_ID,
      action: "rotate",
      rotate: 90,
      flipHorizontal: true,
    });

    expect(response.status).toBe(200);
    // Rotating first gives B R / W G; mirroring that gives R B / G W. The other order
    // would produce W G / B R — a different image, and a crop drawn over the wrong pixels.
    await expect(pixels(store.put[0].body)).resolves.toEqual([RED, BLUE, GREEN, WHITE]);
  });

  it("takes a mirror alongside a crop, in one pass", async () => {
    await seedImage({}, await quadPng());
    // The crop is measured against the mirrored frame: its left column is the old right one.
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      flipHorizontal: true,
      crop: { x: 0, y: 0, width: 1, height: 2 },
    });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([GREEN, WHITE]);
  });

  it("measures a crop against a vertically mirrored frame", async () => {
    await seedImage({}, await quadPng());
    // Mirrored: B W / R G. The top row is the old bottom one.
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      flipVertical: true,
      crop: { x: 0, y: 0, width: 2, height: 1 },
    });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([BLUE, WHITE]);
  });

  it("crops a quarter turn and a mirror together, in the order the panel shows them", async () => {
    await seedImage({}, await quadPng());
    // Turned: B R / W G. Mirrored top-to-bottom: W G / B R. Left column: W over B.
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      rotate: 90,
      flipVertical: true,
      crop: { x: 0, y: 0, width: 1, height: 2 },
    });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([WHITE, BLUE]);
  });

  it("crops a half turn and a mirror together", async () => {
    await seedImage({}, await quadPng());
    // Turned: W B / G R. Mirrored left-to-right: B W / R G. Left column: B over R.
    const response = await edit({
      fileId: FILE_ID,
      action: "crop",
      rotate: 180,
      flipHorizontal: true,
      crop: { x: 0, y: 0, width: 1, height: 2 },
    });

    expect(response.status).toBe(200);
    await expect(pixels(store.put[0].body)).resolves.toEqual([BLUE, RED]);
  });

  it("refuses an angle that is not a quarter turn", async () => {
    await seedImage({}, await quadPng());
    // Anything else pads the canvas with background, so the crop drawn over the preview
    // would no longer describe the same pixels.
    const response = await edit({ fileId: FILE_ID, action: "rotate", rotate: 45 });

    expect(response.status).toBe(400);
    expect(store.put).toHaveLength(0);
    expect(store.updates).toHaveLength(0);
  });

  it("logs a flip as a flip", async () => {
    await seedImage({}, await quadPng());
    await edit({ fileId: FILE_ID, action: "flip", flipVertical: true });
    expect(store.activity).toEqual([{ action: "edit", metadata: { action: "flip" } }]);
  });
});

describe("POST /api/files/edit — format conversion", () => {
  it("writes the asked-for format and renames the file to match", async () => {
    await seedImage();
    const response = await edit({ fileId: FILE_ID, action: "convert", format: "webp" });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: { mimeType: "image/webp" } });
    expect(store.put[0].contentType).toBe("image/webp");
    expect((await sharp(store.put[0].body).metadata()).format).toBe("webp");
    // An extension that lies about the bytes breaks every later read of the file.
    expect(store.updates[0]).toMatchObject({ mimeType: "image/webp", name: "photo.webp" });
    // In-place, so the bytes it replaced stay reachable as a version.
    expect(store.snapshots).toBe(1);
    expect(store.recalculated).toEqual(["user-1"]);
  });

  it("records the target format in the activity line", async () => {
    await seedImage();
    await edit({ fileId: FILE_ID, action: "convert", format: "avif" });
    expect(store.activity).toEqual([
      { action: "edit", metadata: { action: "convert", format: "avif" } },
    ]);
  });

  it("converts a JPEG to PNG without carrying the old extension over", async () => {
    await seedImage({ mimeType: "image/jpeg", name: "photo.jpg" }, await jpeg(32, 32));
    const response = await edit({ fileId: FILE_ID, action: "convert", format: "png" });

    expect(response.status).toBe(200);
    expect((await sharp(store.put[0].body).metadata()).format).toBe("png");
    expect(store.updates[0]).toMatchObject({ mimeType: "image/png", name: "photo.png" });
  });

  it("keeps a conversion to PNG lossless, because PNG has no quality to trade", async () => {
    const source = await gradientPng();
    await seedImage({}, source);
    const response = await edit({ fileId: FILE_ID, action: "convert", format: "png" });

    expect(response.status).toBe(200);
    // Asking for a PNG is asking for a PNG, not for a 256-colour one.
    const before = new Set(await pixels(source));
    const after = new Set(await pixels(store.put[0].body));
    expect(before.size).toBeGreaterThan(256);
    expect(after).toEqual(before);
  });

  it("still quantises when a compress asked for it", async () => {
    await seedImage({}, await gradientPng());
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 80 });

    expect(response.status).toBe(200);
    // The palette branch is what makes "quality" mean anything for a PNG at all.
    expect(new Set(await pixels(store.put[0].body)).size).toBeLessThanOrEqual(256);
  });

  it("leaves the name alone when the target is the format it already was", async () => {
    await seedImage();
    const response = await edit({ fileId: FILE_ID, action: "convert", format: "png" });

    expect(response.status).toBe(200);
    expect(store.updates[0]).not.toHaveProperty("name");
    expect(store.updates[0]).not.toHaveProperty("mimeType");
  });

  it("corrects a copy's extension for the format it was converted into", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "convert",
      format: "webp",
      saveAsCopy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: { name: "photo (edited).webp", mimeType: "image/webp", savedAsCopy: true },
    });
    expect(store.inserts[0]).toMatchObject({
      name: "photo (edited).webp",
      mimeType: "image/webp",
    });
    expect(store.put[0].contentType).toBe("image/webp");
    // The thumbnail worker is told what the bytes actually are.
    expect(store.jobs[0].data).toMatchObject({ mimeType: "image/webp" });
    // A copy leaves this file's bytes alone, so there is nothing to keep a version of.
    expect(store.snapshots).toBe(0);
  });

  it("refuses a format it cannot name, rather than guessing one", async () => {
    await seedImage();
    const response = await edit({ fileId: FILE_ID, action: "convert", format: "tiff" });

    expect(response.status).toBe(400);
    expect(store.put).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("converts and resizes in the same pass", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "convert",
      format: "webp",
      width: 32,
      height: 32,
    });

    expect(response.status).toBe(200);
    const meta = await sharp(store.put[0].body).metadata();
    expect(meta.format).toBe("webp");
    expect([meta.width, meta.height]).toEqual([32, 32]);
  });
});

describe("POST /api/files/edit — quota and accounting", () => {
  it("keeps usedBytes in step with the new object size", async () => {
    await seedImage();
    await edit({ fileId: FILE_ID, action: "resize", width: 32 });

    // Without this the account drifts away from what it actually stores, one edit at
    // a time, and the quota is read from the drifted number.
    expect(store.recalculated).toEqual(["user-1"]);
  });

  it("refuses an edit that would go over the quota, before writing anything", async () => {
    await seedImage({ sizeBytes: 10 });
    store.owner = { quotaBytes: 10, usedBytes: 10, reservedBytes: 0 };
    const response = await edit({ fileId: FILE_ID, action: "compress", quality: 90 });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(store.put).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("charges a copy for its full size rather than for the difference", async () => {
    await seedImage();
    store.owner = { quotaBytes: 10, usedBytes: 0, reservedBytes: 0 };
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: 32,
      saveAsCopy: true,
    });

    expect(response.status).toBe(413);
    expect(store.inserts).toEqual([]);
    expect(store.put).toEqual([]);
  });

  it("lets the edit through when the account row has gone missing", async () => {
    // A quota that cannot be read is not a reason to refuse an edit the caller is
    // otherwise allowed to make.
    await seedImage();
    store.owner = null;
    expect((await edit({ fileId: FILE_ID, action: "resize", width: 32 })).status).toBe(200);
  });

  it("logs the edit against the file", async () => {
    await seedImage();
    await edit({ fileId: FILE_ID, action: "rotate", rotate: 180 });
    expect(store.activity).toEqual([{ action: "edit", metadata: { action: "rotate" } }]);
  });
});

describe("POST /api/files/edit — save as copy", () => {
  it("writes a new file and leaves the original alone", async () => {
    await seedImage();
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: 32,
      saveAsCopy: true,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        fileId: NEW_FILE_ID,
        name: "photo (edited).png",
        savedAsCopy: true,
      },
    });
    expect(store.inserts[0]).toMatchObject({
      userId: "user-1",
      folderId: null,
      name: "photo (edited).png",
      mimeType: "image/png",
      r2Key: "pending",
      isNote: false,
    });
    // A new object key, so the original bytes are never touched — and therefore no
    // version needs keeping.
    expect(store.put[0].key).toBe(`users/user-1/objects/${NEW_FILE_ID}`);
    expect(store.snapshots).toBe(0);
    expect(store.recalculated).toEqual(["user-1"]);
    expect(store.jobs).toEqual([
      {
        type: "generate_thumbnail",
        data: {
          fileId: NEW_FILE_ID,
          r2Key: `users/user-1/objects/${NEW_FILE_ID}`,
          mimeType: "image/png",
        },
      },
    ]);
    expect(store.activity).toEqual([
      { action: "copy", metadata: { sourceId: FILE_ID, via: "edit" } },
    ]);
  });

  it("files the copy under the owner, not under whoever edited it", async () => {
    // A shared file edited by a collaborator must not land in the collaborator's
    // account: the object key and the row both follow the owner.
    await seedImage({ userId: "owner-9" });
    await edit({ fileId: FILE_ID, action: "resize", width: 32, saveAsCopy: true });

    expect(store.inserts[0]).toMatchObject({ userId: "owner-9" });
    expect(store.put[0].key).toBe(`users/owner-9/objects/${NEW_FILE_ID}`);
    expect(store.recalculated).toEqual(["owner-9"]);
  });

  it("corrects the copy's extension when the format had to change", async () => {
    const tiff = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 9, g: 9, b: 9 } },
    })
      .tiff()
      .toBuffer();
    await seedImage({ mimeType: "image/tiff", name: "scan.tiff" }, tiff);
    const response = await edit({
      fileId: FILE_ID,
      action: "compress",
      quality: 70,
      saveAsCopy: true,
    });

    await expect(response.json()).resolves.toMatchObject({
      data: {
        name: "scan (edited).jpg",
        mimeType: "image/jpeg",
      },
    });
  });

  it("refuses a destination the caller cannot write to, before downloading", async () => {
    await seedImage();
    store.destination = { ok: false, status: 403, message: "You can't add files here" };
    const response = await edit({
      fileId: FILE_ID,
      action: "resize",
      width: 32,
      saveAsCopy: true,
    });

    expect(response.status).toBe(403);
    expect(store.r2Calls).toBe(0);
    expect(store.inserts).toEqual([]);
  });
});

describe("PUT /api/files/edit — trim window", () => {
  it("queues a valid window", async () => {
    seedMedia();
    const response = await trim({ fileId: FILE_ID, startSeconds: 1, endSeconds: 5 });

    expect(response.status).toBe(200);
    expect(store.jobs).toEqual([
      {
        type: "trim_media",
        data: {
          fileId: FILE_ID,
          r2Key: `files/${FILE_ID}`,
          mimeType: "video/mp4",
          startSeconds: 1,
          endSeconds: 5,
        },
      },
    ]);
  });

  it("keeps a version, because the job overwrites the object in place", async () => {
    seedMedia();
    await trim({ fileId: FILE_ID, startSeconds: 1, endSeconds: 5 });
    expect(store.snapshots).toBe(1);
  });

  it("refuses an inverted window instead of emptying the file", async () => {
    seedMedia();
    const response = await trim({ fileId: FILE_ID, startSeconds: 10, endSeconds: 5 });

    expect(response.status).toBe(400);
    expect(store.jobs).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("refuses a zero-length window", async () => {
    seedMedia();
    expect((await trim({ fileId: FILE_ID, startSeconds: 5, endSeconds: 5 })).status).toBe(400);
    expect(store.jobs).toEqual([]);
  });

  it("refuses a window longer than a day", async () => {
    seedMedia();
    const response = await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 1e12 });
    expect(response.status).toBe(400);
    expect(store.jobs).toEqual([]);
  });
});

describe("PUT /api/files/edit — what can be trimmed", () => {
  it("refuses to run ffmpeg over something that is not media", async () => {
    seedMedia({ mimeType: "application/pdf", name: "a.pdf" });
    const response = await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 5 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "TRIM_MIME_REFUSED" });
    expect(store.jobs).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("accepts audio", async () => {
    seedMedia({ mimeType: "audio/mpeg", name: "a.mp3" });
    expect((await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 5 })).status).toBe(200);
    expect(store.jobs).toHaveLength(1);
  });

  it("refuses a container a stream copy cannot be written back into", async () => {
    // A trim copies streams rather than re-encoding, and a stream copy cannot change
    // container — so a type with no container to write back to is refused here rather
    // than queued to fail where the user will never see it.
    seedMedia({ mimeType: "video/x-flv", name: "old.flv" });
    const response = await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 5 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "TRIM_CONTAINER_UNSUPPORTED",
    });
    expect(store.jobs).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("refuses an encrypted file, which ffmpeg would be handed as ciphertext", async () => {
    seedMedia({ encrypted: true });
    const response = await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 5 });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "TRIM_ENCRYPTED_REFUSED" });
    expect(store.jobs).toEqual([]);
    expect(store.snapshots).toBe(0);
  });

  it("403s a viewer who cannot edit", async () => {
    seedMedia();
    store.canEdit = false;
    expect((await trim({ fileId: FILE_ID, startSeconds: 0, endSeconds: 5 })).status).toBe(403);
    expect(store.jobs).toEqual([]);
  });
});

describe("PUT /api/files/edit — the queue has to exist", () => {
  it("says so instead of reporting a job nobody will run", async () => {
    // `{ queued: true }` with no worker behind it left the caller waiting for a file
    // that was never going to change.
    seedMedia();
    store.queueUp = false;
    const response = await trim({ fileId: FILE_ID, startSeconds: 1, endSeconds: 5 });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "TRIM_QUEUE_UNAVAILABLE",
    });
    // Checked before the snapshot, so an unreachable queue leaves no version row.
    expect(store.snapshots).toBe(0);
  });

  it("logs the trim with its window", async () => {
    seedMedia();
    await trim({ fileId: FILE_ID, startSeconds: 2.5, endSeconds: 9 });
    expect(store.activity).toEqual([
      { action: "edit", metadata: { action: "trim", startSeconds: 2.5, endSeconds: 9 } },
    ]);
  });
});
